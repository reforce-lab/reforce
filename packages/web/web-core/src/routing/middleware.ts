import type { RequestContext } from "@/execution/request-context";
import type { RouteOutcome, RouteResponse } from "@/execution/route-response";
import type { WebPhase } from "@/routing/vocabulary";

// 中间件只有一个概念（ADR 0006 W4）：洋葱模型的 bean。await next() 前后两相覆盖
// interceptor 语义，不调 next() 直接返回响应即 guard 短路；依赖注入走普通构造注入。
//
// **签名在 #340 改过**：`next()` 交出的是内部货币 `RouteResponse`（读 `.status`、改
// `.headers` 与此前逐字相同），而返回类型带上 `| Response`，让中间件的逃生口与 handler 的
// 逃生口是同一件事、经同一个 seam 吸收。断掉的是把 `next()` 结果当标准 `Response` 用的写法
// （`.json()` / `.text()` / `instanceof Response`）——那些语义本就不该在洋葱层出现，响应体
// 在这一层可能还是一条没读的流。要显式造响应用 `respond(context.responseHeaders, ...)`。
export interface RouteMiddleware {
  handle(
    context: RequestContext,
    next: () => Promise<RouteResponse>,
  ): RouteOutcome | Promise<RouteOutcome>;
}

// 字段形态的 handle 类型。用途是给零标注写法一条路：TS 只在上下文类型位置（类字段 +
// 箭头函数）给参数做上下文类型化，方法参数无论 implements、抽象基类还是装饰器签名都拿不到
// （实测 tsgo 7.0.2 四种形态全部 TS7006）。方法形态仍是文档默认，两种写法运行时等价——
// web-application.ts 用 Reflect.get(instance, "handle") 判定，属性同样命中。
export type MiddlewareHandle = (
  context: RequestContext,
  next: () => Promise<RouteResponse>,
) => RouteOutcome | Promise<RouteOutcome>;

export type ErrorHandlerHandle<E = unknown, R = unknown> = (
  error: E,
  context: RequestContext,
) => R | Promise<R>;

// 错误处理器是唯一单列的概念（ADR 0006 W4 待打磨项定案，#152）：handler 侧内层边界与
// 适配器侧外层兜底共用同一分派——按 (order, beanId) 逐个尝试，返回 Response 即接管，
// (重新)throw 交给下一个，全部放弃后框架默认兜底。它只改写错误出口，摸不到成功响应。
// S3（#275）起处理器可类型化：E 收窄成项目错误类即 instanceof 闸，R 收窄成响应契约配合
// 类上 @ResponseStatus 走编码序列化。方法语法双变，S2 的 Response 实现者全部原样兼容。
export interface RouteErrorHandler<E = unknown, R = unknown> {
  handle(error: E, context: RequestContext): R | Promise<R>;
}

export interface MiddlewareOptions {
  // 缺省 application 阶段、序值 0；global 缺省 false（仅经 @Use 挂载的路由生效）。
  readonly phase?: WebPhase;
  readonly order?: number;
  readonly global?: boolean;
}

export interface ErrorHandlerOptions {
  readonly order?: number;
}
