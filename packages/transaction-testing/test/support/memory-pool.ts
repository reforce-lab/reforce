import { AsyncLocalStorage } from "node:async_hooks";
import type { MemoryMutations } from "./mutations";

// 模块求值期捕获的 snapshot 是空上下文（Node 26 实测）。真实的丢失形态是"池把排队的工作放进
// 恢复出来的上下文里执行"——只有包住工作本身才会丢：从 snapshot 里 resolve 一个 promise，
// 等待方的续体仍然带着自己的上下文（同样实测确认过）。dropAsyncContext 变异因此包住 work。
const contextAtModuleLoad = AsyncLocalStorage.snapshot();

// 有界连接池：F1 的"池大小 + 5 次失败事务不耗尽池"没有真实的租借/归还就是永真断言。
export class MemoryPool {
  private available: number;
  private readonly waiting: (() => void)[] = [];
  private armedAcquireFailure: Error | undefined;

  constructor(
    readonly size: number,
    private readonly mutations: MemoryMutations,
  ) {
    this.available = size;
  }

  armAcquireFailure(error: Error): void {
    this.armedAcquireFailure = error;
  }

  async lease<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      if (this.mutations.dropAsyncContext === true) {
        return await contextAtModuleLoad(work);
      }
      return await work();
    } finally {
      this.release();
    }
  }

  reset(): void {
    this.available = this.size;
    this.waiting.length = 0;
    this.armedAcquireFailure = undefined;
  }

  private async acquire(): Promise<void> {
    const armed = this.armedAcquireFailure;
    if (armed !== undefined) {
      this.armedAcquireFailure = undefined;
      throw armed;
    }
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next === undefined) {
      this.available += 1;
      return;
    }
    next();
  }
}
