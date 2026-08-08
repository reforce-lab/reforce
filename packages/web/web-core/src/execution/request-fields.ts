import { currentRequestFacts, type RequestFacts, runWithRequestFacts } from "@reforce/core";

// 请求字段贡献者（RFC 0011 L4，#242 影响面点名的「@reforce/web-core：请求字段的 LogFieldSource
// 实现」）。
//
// 它解决的是这个：`OrderService` 在处理请求的过程中打的 `order placed`，记录里只有它自己给的
// 字段——是哪个请求触发的看不出来。请求完成时那条日志有 method/path，但那是**另一条**记录，
// 靠时间戳去拼是猜。有了这个 source，请求期间的每一条应用日志都自带 method 与 path。
//
// **这里此前自己持有一个 ALS**，与 @reforce/core 的请求作用域各跑一次 `run()`。#380 把两者合成
// 一个模块级单例（实测单层 run 约 175ns、两层约 415ns，而两者的传播边界逐字相同），本文件
// 因此退化成「往那个 store 里放 web 的三个键、再读回来」的薄层。
//
// 用 type 而不是 interface：interface 没有隐式索引签名，赋不进 `RequestFacts` 要求的
// `Readonly<Record<string, unknown>>`，那会逼出一个 as。
export type WebRequestFacts = {
  readonly method: string;
  readonly path: string;
  // request id 开箱件(#303):请求期间每条应用日志自带,与响应头 x-request-id 恒等。
  readonly requestId: string;
};

/**
 * 只带请求事实、不开请求 bean 仓的入场（#380）：给「注册了 logger 但一个请求作用域 bean 都
 * 没有」的应用用。有请求 bean 时走的是 `context.runInRequestScope(seeds, body, facts)`，
 * 同一个 store 一次开完，不能再往里套这个。
 */
export function runWithRequestFields<T>(facts: WebRequestFacts, callback: () => T): T {
  return runWithRequestFacts(facts, callback);
}

// 请求期间任何位置读当前 request id(#303):handler、seeder、错误分派的 500 日志都用它;
// 请求作用域之外(引擎级 404、启动期)是 undefined。
//
// #380 起还有一种 undefined：既没有请求作用域 bean、又没注册 logger 的应用整个请求都不开
// 作用域。编译期看不见函数体里的自由函数调用，堵不住这个洞；而那种配置下本来也没有任何
// 东西在消费 request id（响应头那个是传值的，全程不经 ALS）。
//
// 按 typeof 复检而不是断言：store 的键由写入方决定，容器不解释它们，类型系统在读回点推不回
// 本包写进去的那三个键。
export function currentRequestId(): string | undefined {
  const requestId = currentRequestFacts()?.requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

/**
 * `LogFieldSource` 的实现（结构性满足，不 import 它的类型）。
 *
 * 不 `import type { LogFieldSource }`：type-only import 会留在生成的 d.ts 里，等于把
 * @reforce/logging-contracts 变成 @reforce/web-core 的硬依赖——同 RequestLogger 的理由。
 *
 * 它没有 `@Injectable()`：@reforce/web-core 不是 starter（没有 reforce-meta.json），本包的任何类都
 * 不会自己进图。用法与 DefaultLoggerFactory 一致——应用写一个薄的 `@Injectable()` 子类并
 * `implements LogFieldSource`，注册与否是用户的决定。
 */
export class WebRequestFields {
  // 返回类型是 `RequestFacts` 而不是 `WebRequestFacts`（#380）：读回点拿到的就是容器那个
  // 不解释内容的 store，而 `LogFieldSource.fields()` 要的恰是这个宽度。直接把存的那个对象
  // 交出去，不复制：它是 readonly 的，而这是每条日志都要走的热路径。
  fields(): RequestFacts | undefined {
    return currentRequestFacts();
  }
}
