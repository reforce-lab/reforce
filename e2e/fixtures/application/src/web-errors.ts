import { ErrorHandler, ResponseStatus } from "@reforce/web";

// 错误处理器分派（ADR 0006 W4）：认识的错误接管成 418，其余重新抛出交给框架默认兜底
// ——校验失败 400、HttpError 按它自己的状态码、其余 500 + errorId，三者都是 RFC 9457
// problem+json（ADR 0013 决议 7，#294）。match-all 回归哨兵:S2 形态的处理器在 S3 下
// 原样工作。
@ErrorHandler()
export class TeapotErrorHandler {
  handle(error: unknown): Response {
    if (error instanceof Error && error.message === "boom") {
      return new Response("teapot", { status: 418 });
    }
    throw error;
  }
}

// 类型化处理器(RFC 0012 S3,#275):accepts = handle 参数 0 的项目错误类(运行时 instanceof
// 闸),@ResponseStatus 钉状态码,返回值经白名单编码器出线(bigint → 字符串)。
export class OrderRejectedError extends Error {
  constructor(readonly orderId: bigint) {
    super("order rejected");
  }
}

export class QuotaExceededError extends Error {}

@ErrorHandler()
@ResponseStatus(409)
export class OrderRejectedHandler {
  handle(error: OrderRejectedError): { code: string; orderId: bigint } {
    return { code: "ORDER_REJECTED", orderId: error.orderId };
  }
}

@ErrorHandler()
@ResponseStatus(429)
export class QuotaExceededHandler {
  handle(_error: QuotaExceededError): { code: string } {
    return { code: "QUOTA_EXCEEDED" };
  }
}
