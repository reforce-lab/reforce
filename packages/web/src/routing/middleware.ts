import type { RequestContext } from "@/execution/request-context";
import type { WebPhase } from "@/routing/vocabulary";

// 中间件只有一个概念（ADR 0006 W4）：洋葱模型的 bean。await next() 前后两相覆盖
// interceptor 语义，不调 next() 直接返回响应即 guard 短路；依赖注入走普通构造注入。
export interface RouteMiddleware {
  handle(context: RequestContext, next: () => Promise<Response>): Response | Promise<Response>;
}

// 字段形态的 handle 类型。用途是给零标注写法一条路：TS 只在上下文类型位置（类字段 +
// 箭头函数）给参数做上下文类型化，方法参数无论 implements、抽象基类还是装饰器签名都拿不到
// （实测 tsgo 7.0.2 四种形态全部 TS7006）。方法形态仍是文档默认，两种写法运行时等价——
// web-application.ts 用 Reflect.get(instance, "handle") 判定，属性同样命中。
export type MiddlewareHandle = (
  context: RequestContext,
  next: () => Promise<Response>,
) => Response | Promise<Response>;

export type ErrorHandlerHandle = (
  error: unknown,
  context: RequestContext,
) => Response | Promise<Response>;

// 错误处理器是唯一单列的概念（ADR 0006 W4 待打磨项定案，#152）：handler 侧内层边界与
// 适配器侧外层兜底共用同一分派——按 (order, beanId) 逐个尝试，返回 Response 即接管，
// (重新)throw 交给下一个，全部放弃后框架默认兜底。它只改写错误出口，摸不到成功响应。
export interface RouteErrorHandler {
  handle(error: unknown, context: RequestContext): Response | Promise<Response>;
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
