import { randomUUID } from "node:crypto";
import { RequestValidationError } from "@/errors";
import type { RequestContext } from "@/execution/request-context";
import type { ErrorLogger } from "@/execution/web-application";
import type { RouteErrorHandler } from "@/routing/middleware";

// 错误分派（ADR 0006 W4 待打磨项定案，#152）：按路由表写死的顺序逐个尝试注册的错误处理
// bean——返回 Response 即接管；(重新)throw 则把抛出的错误交给下一个（换错即升级，原错不再
// 保留）；全部放弃后进框架默认兜底。兜底闭集：校验失败 → 400 + 脱敏 issues；其余 → 500 + errorId。
// 分派器对调用方的保证：永不 reject。

const encoder = new TextEncoder();

function jsonResponse(status: number, body: Readonly<Record<string, unknown>>): Response {
  // content-length 同 serialization.ts 的 jsonResponse：适配器据它选 Buffer / 流路径
  // （见 adapter.ts 的契约块）。长度取字节数，文案可以带非 ASCII。
  const bytes = encoder.encode(JSON.stringify(body));
  return new Response(bytes, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(bytes.byteLength),
    },
  });
}

// 500 兜底（RFC 0011 C1，#250）。此前是 `new Response(undefined, { status: 500 })`——错误
// **完全被吞掉**：不打日志，客户端也拿不到任何线索，运维只能靠时间戳猜是哪一条。
//
// errorId 与 request id 解耦：它只在 500 真的发生时生成，常态零开销（randomUUID 不在热路径
// 上），而排查价值最大的场景照样覆盖——用户报一个 id，日志里一次 grep 就到现场。
//
// **栈绝不进响应**：栈里有源码路径、依赖版本、有时还有拼进消息的参数值。响应只带 errorId，
// 栈进日志——两者由同一个 id 关联。
function fallbackResponse(error: unknown, logger: ErrorLogger | undefined): Response {
  if (error instanceof RequestValidationError) {
    return jsonResponse(400, {
      error: "request validation failed",
      source: error.source,
      issues: error.issues.map((issue) => ({ message: issue.message, path: issue.path })),
    });
  }
  const errorId = randomUUID();
  // 日志失败不得把响应带下去：dispatchError 永不 reject 是适配器契约的一部分（#226），
  // 而 logger 是用户的——serializer 与 LogFieldSource.fields() 都可能抛。
  try {
    logger?.error({ errorId, err: error }, "unhandled error");
  } catch {
    // 记不上就记不上，客户端仍拿到 errorId，只是这次日志里没有对应现场。
  }
  return jsonResponse(500, { error: "internal", errorId });
}

export type ErrorDispatcher = (error: unknown, context: RequestContext) => Promise<Response>;

export function createErrorDispatcher(
  handlers: readonly RouteErrorHandler[],
  logger?: ErrorLogger,
): ErrorDispatcher {
  return async (error, context) => {
    let current = error;
    for (const handler of handlers) {
      try {
        return await handler.handle(current, context);
      } catch (next) {
        current = next;
      }
    }
    return fallbackResponse(current, logger);
  };
}
