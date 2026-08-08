import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestFacts } from "@/public-types";

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

// 请求事实为什么挤进请求作用域这个 store，而不是自己再要一个 ALS（#380）：
// `AsyncLocalStorage.run()` 实测单层约 175ns、两层约 415ns，每请求两层就是两份固定开销，
// 而两者的传播边界逐字相同（都是「这次请求的 await 链」）。
interface RequestScopeStore {
  /**
   * 这一仓归哪个 `RequestScope` 实例（= 哪个 ApplicationContext）。
   *
   * 只有请求 bean 仓需要认主：beanId 是字符串，同一个类在两个 context 里生成的是同一个 id，
   * 不比一次 owner 就会**安静地取到别人那次请求的实例**（#380）。请求事实相反——method 与
   * requestId 是关于这次 HTTP 请求的事实，与哪个 context 无关，谁读都对，所以它不认主。
   */
  readonly owner: RequestScope | undefined;
  readonly beans: RequestStore | undefined;
  readonly facts: RequestFacts | undefined;
}

// 模块级单例而不是每 context 一个实例（#380）。per-context 方案能天然隔离请求仓，代价是请求
// 事实被连坐：想读 request id 的代码（pino 的 serializer、starter 里的工具函数）手上没有
// context，全都得先变成 bean，而这个约束会传染。模块级把隔离责任放回 owner 比较那一处——
// 一次引用比较，热路径上约等于免费，隔离保证与 per-context 相同，且跨 context 读从「悄悄
// 取错」变成「明确不在作用域」。同形先例是 @reforce/transaction 的 scope.ts。
const storage = new AsyncLocalStorage<RequestScopeStore>();

export class RequestScope {
  active(): RequestStore | undefined {
    const store = storage.getStore();
    return store?.owner === this ? store.beans : undefined;
  }

  // 嵌套调用即独立请求：ALS 天然影子化，内层结束后外层仓自动恢复。
  run<T>(beans: RequestStore, facts: RequestFacts | undefined, callback: () => T): T {
    return storage.run({ owner: this, beans, facts }, callback);
  }
}

/**
 * 只带请求事实、不开请求 bean 仓的作用域（#380）。
 *
 * 存在理由是「注册了 logger 但一个请求作用域 bean 都没有」这一档：那种应用仍然要每条日志
 * 自带 method/path/requestId，但没有任何仓要开，`runInRequestScope` 那条 async 路径（状态
 * 检查 + 建仓 + 走一遍空计划）纯属白付。
 *
 * 它会影子掉外层的请求 bean 仓，所以调用方必须二选一，不能套在 `runInRequestScope` 里面。
 */
export function runWithRequestFacts<T>(facts: RequestFacts, callback: () => T): T {
  return storage.run({ owner: undefined, beans: undefined, facts }, callback);
}

/** 当前请求的事实；不在请求内是 undefined。不认主，理由见 `RequestScopeStore.owner`。 */
export function currentRequestFacts(): RequestFacts | undefined {
  return storage.getStore()?.facts;
}
