import {
  Middleware,
  type RequestContext,
  type RouteMiddleware,
  UnauthorizedError,
} from "@reforce/web";
import type { AppConfig } from "@/config/app.config";

// admission 阶段：认证、授权、限流都在这一层，比 application 阶段更靠外，比 observability
// 更靠内。
//
// 没写 global，因为它只挂在需要的路由上（见 greeting.controller.ts 的 @Use）。
//
// 中间件也是普通 bean，构造注入照用：配置就是这么进来的。
@Middleware({ phase: "admission" })
export class ApiKeyMiddleware implements RouteMiddleware {
  constructor(private readonly config: AppConfig) {}

  async handle(context: RequestContext, next: () => Promise<Response>): Promise<Response> {
    // 没配 API key 就整条放行——模板的便利，不是生产该有的行为。
    if (this.config.apiKey === undefined) {
      return await next();
    }
    if (context.request.headers.get("x-api-key") !== this.config.apiKey) {
      // 这里也可以直接 return 一个 401 Response——不调 next() 就是短路。抛异常更省事：
      // UnauthorizedError 自带 401，框架统一渲染成 problem+json，中间件不必自己拼响应。
      throw new UnauthorizedError("缺少或错误的 x-api-key。");
    }
    return await next();
  }
}
