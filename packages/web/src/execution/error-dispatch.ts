import { RequestValidationError } from "@/errors";
import type { RequestContext } from "@/execution/request-context";
import type { RouteErrorHandler } from "@/routing/middleware";

// 错误分派（ADR 0006 W4 待打磨项定案，#152）：按路由表写死的顺序逐个尝试注册的错误处理
// bean——返回 Response 即接管；(重新)throw 则把抛出的错误交给下一个（换错即升级，原错不再
// 保留）；全部放弃后进框架默认兜底。兜底闭集：校验失败 → 400 + 脱敏 issues；其余 → 500 空体。
// 分派器对调用方的保证：永不 reject。

const encoder = new TextEncoder();

function fallbackResponse(error: unknown): Response {
  if (error instanceof RequestValidationError) {
    // content-length 同 serialization.ts 的 jsonResponse：适配器据它选 Buffer / 流路径
    // （见 adapter.ts 的契约块）。长度取字节数，issue 文案可以带非 ASCII。
    const bytes = encoder.encode(
      JSON.stringify({
        error: "request validation failed",
        source: error.source,
        issues: error.issues.map((issue) => ({ message: issue.message, path: issue.path })),
      }),
    );
    return new Response(bytes, {
      status: 400,
      headers: {
        "content-type": "application/json",
        "content-length": String(bytes.byteLength),
      },
    });
  }
  return new Response(undefined, { status: 500 });
}

export type ErrorDispatcher = (error: unknown, context: RequestContext) => Promise<Response>;

export function createErrorDispatcher(handlers: readonly RouteErrorHandler[]): ErrorDispatcher {
  return async (error, context) => {
    let current = error;
    for (const handler of handlers) {
      try {
        return await handler.handle(current, context);
      } catch (next) {
        current = next;
      }
    }
    return fallbackResponse(current);
  };
}
