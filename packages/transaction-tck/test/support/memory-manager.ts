import { AsyncLocalStorage } from "node:async_hooks";
import {
  activeResourceFor,
  type NestedTransactionManager,
  type TransactionIsolation,
  TransactionIsolationUnsupportedError,
  type TransactionOptions,
  TransactionTimeoutError,
  TransactionTimeoutUnsupportedError,
} from "@reforce/context";
import type { TransactionTckCapabilities, TransactionTckHarness } from "@/index";
import { MemoryDatabase, type MemoryTransaction } from "./memory-database";
import { MemoryPool } from "./memory-pool";
import type { MemoryMutations } from "./mutations";

// 内存假 manager：正确实现 + 一组可注入的变异。它同时是 TCK 的自测夹具和"契约到底要求什么"
// 的可读参考实现。

export interface MemoryHarnessOptions {
  readonly name?: string;
  readonly mutations?: MemoryMutations;
  readonly capabilities?: Partial<TransactionTckCapabilities>;
}

const defaultCapabilities: TransactionTckCapabilities = {
  // 故意不含 READ_UNCOMMITTED：D2-RU 因此登记为反验用例。
  isolations: ["READ_COMMITTED", "REPEATABLE_READ", "SERIALIZABLE"],
  timeout: true,
  concurrentWriters: true,
  poolSize: 4,
};

// statementScopedTimeout 变异要让"单条语句超时"这个机制真实存在（哪怕本套用例里没有一条
// 语句慢到触发它）：否则它退化成"完全不实现 timeout"，变异就不再对应现实中的缺陷。
const mutatedStatementDelay = 25;

class MemoryManager implements NestedTransactionManager<MemoryTransaction> {
  private armedCommitFailure: Error | undefined;
  // ORM 自带的 ambient context（MikroORM 的 global EM / RequestContext 是同一件东西）：
  // 它总是被填上，缺陷不在"有"而在"用"——reuseOuterResource 变异就是照默认传播去读它。
  // 注意它不是框架的事务仓：TCK 直接调 withTransaction，activeResourceFor 那条路上没有记录。
  private readonly ambient = new AsyncLocalStorage<MemoryTransaction>();

  constructor(
    private readonly database: MemoryDatabase,
    private readonly pool: MemoryPool,
    private readonly capabilities: TransactionTckCapabilities,
    private readonly mutations: MemoryMutations,
  ) {}

  current(): MemoryTransaction {
    const active = activeResourceFor(this);
    if (active === undefined) {
      throw new Error("The memory manager has no autocommit handle; use withTransaction().");
    }
    return active;
  }

  armCommitFailure(error: Error): void {
    this.armedCommitFailure = error;
  }

  async withTransaction<T>(
    options: TransactionOptions,
    fn: (resource: MemoryTransaction) => Promise<T>,
  ): Promise<T> {
    this.requireSupportedIsolation(options.isolation);
    this.requireSupportedTimeout(options.timeout);
    const reused = this.reusableOuterTransaction();
    if (reused !== undefined) {
      return await fn(reused);
    }
    return await this.pool.lease(async () => {
      const transaction = this.database.begin(options.isolation, this.mutations);
      return await this.ambient.run(transaction, () =>
        this.runBoundary(transaction, options.timeout, fn),
      );
    });
  }

  async withSavepoint<T>(
    resource: MemoryTransaction,
    fn: (resource: MemoryTransaction) => Promise<T>,
  ): Promise<T> {
    resource.pushSavepoint();
    try {
      const result = await fn(resource);
      resource.releaseSavepoint();
      return result;
    } catch (error) {
      resource.rollbackToSavepoint();
      throw error;
    }
  }

  private reusableOuterTransaction(): MemoryTransaction | undefined {
    if (this.mutations.reuseOuterResource !== true) {
      return undefined;
    }
    return this.ambient.getStore();
  }

  private requireSupportedIsolation(isolation: TransactionIsolation | undefined): void {
    if (isolation === undefined || this.capabilities.isolations.includes(isolation)) {
      return;
    }
    if (this.mutations.ignoreUnsupportedIsolation === true) {
      return;
    }
    throw new TransactionIsolationUnsupportedError({ isolation });
  }

  private requireSupportedTimeout(timeout: number | undefined): void {
    if (timeout === undefined || this.capabilities.timeout) {
      return;
    }
    throw new TransactionTimeoutUnsupportedError({ timeout });
  }

  private async runBoundary<T>(
    transaction: MemoryTransaction,
    timeout: number | undefined,
    fn: (resource: MemoryTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await this.raceTimeout(transaction, timeout, () => fn(transaction));
      return await this.commitAndWrap(transaction, result);
    } catch (error) {
      this.rollbackAfter(transaction, error);
      throw this.shouldWrap(error) ? new Error("wrapped by the adapter", { cause: error }) : error;
    }
  }

  private async commitAndWrap<T>(transaction: MemoryTransaction, result: T): Promise<T> {
    const armed = this.armedCommitFailure;
    this.armedCommitFailure = undefined;
    if (armed !== undefined && this.mutations.swallowCommitError !== true) {
      throw armed;
    }
    transaction.commit();
    if (this.mutations.wrapReturnValue !== true) {
      return result;
    }
    // 变异的全部意义就是返回一个不是 T 的值：类型层无从察觉，只有 A3 的引用相等断言
    // 看得见 // justified: 见上
    return { value: result } as T;
  }

  // 变异只针对回调抛出的值。连 manager 自己的超时信号一起包装是另一个缺陷
  // （driverTimeoutError），两个缺陷混进一条变异，期望失败集就不再有诊断价值。
  private shouldWrap(error: unknown): boolean {
    return this.mutations.wrapThrown === true && !(error instanceof TransactionTimeoutError);
  }

  private rollbackAfter(transaction: MemoryTransaction, error: unknown): void {
    const timedOut = error instanceof TransactionTimeoutError;
    if (timedOut && this.mutations.timeoutWithoutRollback === true) {
      transaction.commit();
      return;
    }
    if (!timedOut && this.mutations.commitOnThrow === true) {
      transaction.commit();
      return;
    }
    // 回滚 = 丢弃写缓冲，什么都不做。
  }

  private async raceTimeout<T>(
    transaction: MemoryTransaction,
    timeout: number | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    if (timeout === undefined || this.mutations.ignoreTimeout === true) {
      return await work();
    }
    if (this.mutations.statementScopedTimeout === true) {
      // 预算只约束单条语句：本套用例里没有一条语句慢到触发它，边界因此从不超时。
      return await work();
    }
    if (this.mutations.wallClockCheckedAtStatements === true) {
      return await this.checkedAtStatements(transaction, timeout, work);
    }
    return await this.race(timeout, work);
  }

  private async race<T>(timeout: number, work: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          this.mutations.driverTimeoutError === true
            ? new Error("P2028: transaction API error")
            : new TransactionTimeoutError({ timeout }),
        );
      }, timeout);
    });
    try {
      return await Promise.race([work(), expiry]);
    } finally {
      clearTimeout(timer);
    }
  }

  // 累计墙钟只在发出语句时检查：不发语句就永远不超时（F6 存在的理由）。
  private async checkedAtStatements<T>(
    transaction: MemoryTransaction,
    timeout: number,
    work: () => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    transaction.onStatement = () => {
      if (performance.now() - startedAt > timeout) {
        throw new TransactionTimeoutError({ timeout });
      }
    };
    try {
      return await work();
    } finally {
      transaction.onStatement = undefined;
    }
  }
}

export interface MemoryHarness extends TransactionTckHarness<MemoryTransaction> {
  reset(): Promise<void>;
}

export function memoryHarness(options: MemoryHarnessOptions = {}): MemoryHarness {
  const mutations = options.mutations ?? {};
  const capabilities: TransactionTckCapabilities = {
    ...defaultCapabilities,
    ...options.capabilities,
  };
  const database = new MemoryDatabase();
  const pool = new MemoryPool(capabilities.poolSize, mutations);
  const manager = new MemoryManager(database, pool, capabilities, mutations);
  const statementDelay = mutations.statementScopedTimeout === true ? mutatedStatementDelay : 0;
  const delay = async (): Promise<void> => {
    if (statementDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, statementDelay));
    }
  };
  return {
    name: options.name ?? "in-memory reference manager",
    capabilities,
    manager,
    async write(resource, key, value) {
      await delay();
      resource.write(key, value);
    },
    async read(resource, key) {
      await delay();
      return resource.read(key);
    },
    async readOutside(key) {
      // 旁路连接：只看 committed，不看任何事务的写缓冲。
      return database.committed.get(key);
    },
    async reset() {
      database.reset();
      pool.reset();
    },
    faults: {
      failNextAcquire(): Error {
        const error = new Error("could not acquire a connection");
        pool.armAcquireFailure(error);
        return error;
      },
      failNextCommit(): Error {
        const error = new Error("could not commit");
        manager.armCommitFailure(error);
        return error;
      },
    },
  };
}
