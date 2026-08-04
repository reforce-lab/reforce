import { AsyncLocalStorage } from "node:async_hooks";

// 请求作用域运行时（ADR 0006 W7，#142 / #151）：每个请求一份实例仓，挂在 AsyncLocalStorage 上
// 跟随 await 链传播；请求内按 beanId 记忆化，请求间彼此不可见。构造由编译期的
// requestConstructionOrder 计划驱动，这里只存放状态，不做任何解析决策。

interface RequestConstructingRecord {
  readonly state: "constructing";
}

interface RequestConstructedRecord {
  readonly state: "constructed";
  readonly instance: object;
}

export type RequestInstanceRecord = RequestConstructingRecord | RequestConstructedRecord;

export class RequestStore {
  private readonly recordById = new Map<string, RequestInstanceRecord>();
  private readonly constructionStack: string[] = [];

  seed(id: string, instance: object): void {
    this.recordById.set(id, { state: "constructed", instance });
  }

  record(id: string): RequestInstanceRecord | undefined {
    return this.recordById.get(id);
  }

  beginConstruction(id: string): void {
    this.recordById.set(id, { state: "constructing" });
    this.constructionStack.push(id);
  }

  finishConstruction(id: string, instance: object): void {
    this.recordById.set(id, { state: "constructed", instance });
  }

  abandonConstruction(id: string): void {
    this.recordById.delete(id);
  }

  finishConstructionAttempt(): void {
    this.constructionStack.pop();
  }

  constructionPath(targetId?: string): readonly string[] {
    return targetId ? [...this.constructionStack, targetId] : [...this.constructionStack];
  }
}

export class RequestScope {
  private readonly storage = new AsyncLocalStorage<RequestStore>();

  active(): RequestStore | undefined {
    return this.storage.getStore();
  }

  // 嵌套调用即独立请求：ALS 天然影子化，内层结束后外层仓自动恢复。
  run<T>(store: RequestStore, callback: () => T): T {
    return this.storage.run(store, callback);
  }
}
