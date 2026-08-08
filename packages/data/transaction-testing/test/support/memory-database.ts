import type { TransactionIsolation } from "@reforce/transaction";
import type { MemoryMutations } from "./mutations";

// 内存 key-value 库的 MVCC 内核：committed 快照 + 每事务写缓冲 + savepoint 栈 + aborted 标志。
// 这些不是摆设——没有真快照，D3 在假 manager 上是永真断言；没有 aborted 标志，C6 要抓的
// "只 catch 不回滚"变异根本抓不住。

const snapshotIsolations: readonly TransactionIsolation[] = ["REPEATABLE_READ", "SERIALIZABLE"];

export class MemoryTransaction {
  private readonly writes = new Map<string, string>();
  private readonly savepointStack: Map<string, string>[] = [];
  private snapshot: ReadonlyMap<string, string> | undefined;
  private aborted = false;
  // wallClockCheckedAtStatements 变异的挂钩：每条语句发出前跑一次，模拟"只在发语句时检查
  // 累计墙钟"的近似实现。正确实现不设它。
  onStatement: (() => void) | undefined;

  constructor(
    private readonly database: MemoryDatabase,
    private readonly isolation: TransactionIsolation | undefined,
    private readonly mutations: MemoryMutations,
  ) {}

  read(key: string): string | undefined {
    this.beginStatement();
    if (this.writes.has(key)) {
      return this.writes.get(key);
    }
    return this.visibleStore().get(key);
  }

  write(key: string, value: string): void {
    this.beginStatement();
    this.writes.set(key, value);
  }

  pushSavepoint(): void {
    this.savepointStack.push(new Map(this.writes));
  }

  releaseSavepoint(): void {
    this.savepointStack.pop();
  }

  rollbackToSavepoint(): void {
    const restored = this.savepointStack.pop();
    if (this.mutations.savepointCatchWithoutRollback === true) {
      // 内层的写留在缓冲里，连接进 aborted 态：PG 上最高发的 adapter bug 的忠实模型。
      this.aborted = true;
      return;
    }
    this.writes.clear();
    for (const [key, value] of restored ?? []) {
      this.writes.set(key, value);
    }
  }

  commit(): void {
    this.database.apply(this.writes);
  }

  private beginStatement(): void {
    if (this.aborted) {
      throw new Error("current transaction is aborted, commands ignored until end of block");
    }
    this.onStatement?.();
  }

  // 快照只在第一条读语句处固定（多数引擎的实际行为），D3 的"先读一次建立快照"因此有意义。
  private visibleStore(): ReadonlyMap<string, string> {
    if (!this.usesSnapshot()) {
      return this.database.committed;
    }
    this.snapshot ??= new Map(this.database.committed);
    return this.snapshot;
  }

  private usesSnapshot(): boolean {
    if (this.mutations.allIsolationsAsReadCommitted === true) {
      return false;
    }
    return this.isolation !== undefined && snapshotIsolations.includes(this.isolation);
  }
}

export class MemoryDatabase {
  readonly committed = new Map<string, string>();

  begin(
    isolation: TransactionIsolation | undefined,
    mutations: MemoryMutations,
  ): MemoryTransaction {
    return new MemoryTransaction(this, isolation, mutations);
  }

  apply(writes: ReadonlyMap<string, string>): void {
    for (const [key, value] of writes) {
      this.committed.set(key, value);
    }
  }

  reset(): void {
    this.committed.clear();
  }
}
