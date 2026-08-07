import { Middleware, type RequestContext, type RouteMiddleware } from "@reforce/web";

// 中间件是洋葱：await next() 之前是「请求进来」，之后是「响应出去」，一个类覆盖两相。
//
// phase 是闭集，决定它在链上的哪一层：
//   observability  最外层，观测所有请求与最终响应，不做准入决策（就是这里）
//   admission      认证 / 授权 / 限流——不放行时**不调 next()**，直接 return 一个响应即短路
//   application    默认阶段，贴近 handler 的业务拦截
//
// global: true 表示所有路由都走它；不写就只对用 @Use 显式挂上的路由生效。
@Middleware({ phase: "observability", global: true })
export class RequestLoggingMiddleware implements RouteMiddleware {
  async handle(context: RequestContext, next: () => Promise<Response>): Promise<Response> {
    const startedAt = performance.now();
    try {
      const response = await next();
      RequestLoggingMiddleware.log(context, String(response.status), startedAt);
      return response;
    } catch (error) {
      // 这个 catch 不能省。handler 抛的异常在更内层就被 error-handler 换成了响应，await next()
      // 拿到的是正常 Response；但**更内层中间件**抛出来的（比如 api-key 的 401）走的是整条链
      // 之外的错误出口，不接住的话，这类请求在访问日志里会整条消失——线上表现是「用户说打不
      // 通，日志里查无此请求」。这里拿不到最终状态码，至少留下发生过的记录。
      RequestLoggingMiddleware.log(context, "threw", startedAt);
      throw error;
    }
  }

  private static log(context: RequestContext, outcome: string, startedAt: number): void {
    const elapsed = (performance.now() - startedAt).toFixed(1);
    console.log(`${context.method} ${context.url.pathname} → ${outcome} (${elapsed}ms)`);
  }
}
