import { ErrorHandler } from "@reforce/web";

// 错误处理器分派（ADR 0006 W4）：认识的错误接管成 418，其余重新抛出交给框架默认兜底
// （校验失败 400、未知错误 500 空体）。
@ErrorHandler()
export class TeapotErrorHandler {
  handle(error: unknown): Response {
    if (error instanceof Error && error.message === "boom") {
      return new Response("teapot", { status: 418 });
    }
    throw error;
  }
}
