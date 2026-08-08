import { AsyncLocalStorage } from "node:async_hooks";

// 请求字段贡献者（RFC 0011 L4，#242 影响面点名的「@reforce/web-core：请求字段的 LogFieldSource
// 实现」）。
//
// 它解决的是这个：`OrderService` 在处理请求的过程中打的 `order placed`，记录里只有它自己给的
// 字段——是哪个请求触发的看不出来。请求完成时那条日志有 method/path，但那是**另一条**记录，
// 靠时间戳去拼是猜。有了这个 source，请求期间的每一条应用日志都自带 method 与 path。
//
// **为什么 @reforce/web-core 自己拿一个 ALS**：贡献者要进 LoggerFactory 的集合注入，而工厂是单例、
// 在容器 start 时就造好了，所以贡献者也必须是单例——它读请求态的唯一途径就是 ALS。
// L4 写的「不建第二套上下文机制」针对的是「不要再造一套面向用户的 MDC API」：用户不接触
// 这里的 storage，它只是请求日志的管道。同一形态的先例是 @reforce/transaction 的 scope.ts，
// 它也为自己那件横切事持有一个 ALS。
//
// 用 type 而不是 interface：interface 没有隐式索引签名，赋不进 LogFieldSource 要求的
// `Readonly<Record<string, unknown>>`，那会逼出一个 as。
export type WebRequestFacts = {
  readonly method: string;
  readonly path: string;
  // request id 开箱件(#303):请求期间每条应用日志自带,与响应头 x-request-id 恒等。
  readonly requestId: string;
};

const storage = new AsyncLocalStorage<WebRequestFacts>();

export function runWithRequestFields<T>(facts: WebRequestFacts, callback: () => T): T {
  return storage.run(facts, callback);
}

// 请求期间任何位置读当前 request id(#303):handler、seeder、错误分派的 500 日志都用它;
// 请求作用域之外(引擎级 404、启动期)是 undefined。
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * `LogFieldSource` 的实现（结构性满足，不 import 它的类型）。
 *
 * 不 `import type { LogFieldSource }`：type-only import 会留在生成的 d.ts 里，等于把
 * @reforce/logging 变成 @reforce/web-core 的硬依赖——同 RequestLogger 的理由。
 *
 * 它没有 `@Injectable()`：@reforce/web-core 不是 starter（没有 reforce-meta.json），本包的任何类都
 * 不会自己进图。用法与 DefaultLoggerFactory 一致——应用写一个薄的 `@Injectable()` 子类并
 * `implements LogFieldSource`，注册与否是用户的决定。
 */
export class WebRequestFields {
  // 直接把存的那个对象交出去，不复制：它是 readonly 的，而这是每条日志都要走的热路径。
  fields(): WebRequestFacts | undefined {
    return storage.getStore();
  }
}
