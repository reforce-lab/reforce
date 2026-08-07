import { isReforceError } from "@reforce/core";
import { ErrorHandler, type RequestContext, type RouteErrorHandler } from "@reforce/web";

// 兜底：走到这里的都是没人认领的错误，也就是 bug。order 比 http-error.handler 大，所以它
// 排在后面——分派按 order 升序逐个尝试。
//
// 三件事必须做对：
// 1. **框架自己的错误要放走**。请求校验失败（`RequestValidationError`）也是走错误出口的，
//    一个真·catch-all 会把它变成 500，用户就再也看不到「哪个字段不合法」。重新 throw 出去，
//    框架的默认兜底会给出带 issues 的 400。删掉下面那个 if 就能亲眼看到这个坑。
//    判据用 `isReforceError` 而不是某一个基类：框架错误分四棵子树（容器、事务、web、CLI），
//    只放行 web 那一棵的话，事务护栏报的「你的 manager 有问题」照样会被这里吞成 500。
// 2. **日志要留全**。这是唯一还拿得到原始错误和堆栈的地方，不打就永远查不到。
// 3. **响应里什么都别带**。错误消息经常含表名、文件路径、内部 ID，直接回给调用方就是白送
//    情报。给一句固定文案就够；要能对上日志的话，配合中间件生成的 request id 一起返回。
@ErrorHandler({ order: 100 })
export class FallbackErrorHandler implements RouteErrorHandler {
  handle(error: unknown, context: RequestContext): Response {
    if (isReforceError(error)) {
      throw error;
    }
    console.error(`[unhandled] ${context.method} ${context.url.pathname}`, error);
    return Response.json({ error: "internal server error" }, { status: 500 });
  }
}
