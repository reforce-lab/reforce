import { ErrorHandler, type RequestContext, type RouteErrorHandler } from "@reforce/web";
import { GreetingAlreadyExistsException } from "@/features/greeting/greeting.exception";
import { NotFoundException } from "@/shared/http/not-found.exception";
import { UnauthorizedException } from "@/shared/http/unauthorized.exception";

// @ErrorHandler() 只改错误出口，摸不到成功响应。规则很简单：返回 Response 就算接管，
// 重新 throw 就交给下一个处理器（按 order 升序），全都放弃了框架才兜底。
//
// 所以这里只认自己认识的异常，其余原样抛回去，交给 order 更大的 fallback 处理器。别在这里
// catch-all，那会把「未知错误」和「已知错误」混成一坨，也吃掉 fallback 那层的日志。
//
// 这个文件住在 infrastructure/web/ 而不是跟异常放一起：它翻译的是**所有**异常，跟某一个
// 异常不构成一一对应；跟它绑死的是 HTTP 这个外部协议。异常自己反倒是业务词汇——通用的在
// shared/http/，模块专属的在那个模块目录里。

type ExceptionClass = new (...args: never[]) => Error;

// 异常 → 状态码用一张表，加一种异常就是加一行；写成 if/else if 的话，加到第四种就没人愿意
// 读完整个函数了。
const STATUS_BY_EXCEPTION: readonly (readonly [ExceptionClass, number])[] = [
  [NotFoundException, 404],
  [UnauthorizedException, 401],
  [GreetingAlreadyExistsException, 409],
];

@ErrorHandler()
export class HttpErrorHandler implements RouteErrorHandler {
  handle(error: unknown, _context: RequestContext): Response {
    for (const [exception, status] of STATUS_BY_EXCEPTION) {
      if (error instanceof exception) {
        return Response.json({ error: error.message }, { status });
      }
    }
    throw error;
  }
}
