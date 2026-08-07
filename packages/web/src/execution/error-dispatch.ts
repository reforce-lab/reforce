import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { RequestValidationError } from "@/errors";
import type { RequestContext } from "@/execution/request-context";
import type { ErrorLogger } from "@/execution/web-application";
import { HttpError } from "@/http-errors";
import type { RouteErrorHandler } from "@/routing/middleware";

// 错误分派（ADR 0006 W4 待打磨项定案，#152）：按路由表写死的顺序逐个尝试注册的错误处理
// bean——返回 Response 即接管；(重新)throw 则把抛出的错误交给下一个（换错即升级，原错不再
// 保留）；全部放弃后进框架默认兜底。分派器对调用方的保证：永不 reject。
//
// 兜底闭集（ADR 0013 决议 7，#294）：HttpError → 它自己的 status + code + detail；校验失败
// → 400 + 脱敏 issues；其余 → 500 + errorId。三者都是 RFC 9457 problem+json。

const encoder = new TextEncoder();

// RFC 9457（https://www.rfc-editor.org/rfc/rfc9457.html）：五个标准成员 type/title/status/
// detail/instance，外加任意扩展成员，客户端必须忽略不认识的扩展。Spring 6 / ASP.NET Core /
// Zalando / Quarkiverse / Micronaut 都已收敛于此。
//
// type 暂用 about:blank，识别靠 code 扩展成员；文档站的错误码页就绪后再填真 URI——先把 type
// 指向一个不存在的 URL 等于射箭后画靶。RFC 规定 type 为 about:blank 时 title 就是该状态码的
// HTTP 原因短语，所以 title 取 node:http 的 STATUS_CODES 而不是自建映射：defineHttpError 允许
// 任意状态码，自建表必然覆盖不全。
function problemResponse(status: number, members: Readonly<Record<string, unknown>>): Response {
  const body = {
    type: "about:blank",
    title: STATUS_CODES[status] ?? "Error",
    status,
    ...members,
  };
  // content-length 同 serialization.ts 的 jsonResponse：适配器据它选 Buffer / 流路径
  // （见 adapter.ts 的契约块）。长度取字节数，文案可以带非 ASCII。
  const bytes = encoder.encode(JSON.stringify(body));
  return new Response(bytes, {
    status,
    headers: {
      "content-type": "application/problem+json",
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
// **栈与 message 绝不进 5xx 响应**：栈里有源码路径、依赖版本，message 里常有表名和内部 ID。
// 响应只带 errorId，栈进日志——两者由同一个 id 关联。明确不学 Fastify 5 的默认 500 回显
// error.message。
function fallbackResponse(error: unknown, logger: ErrorLogger | undefined): Response {
  // 用户异常原语（决议 6）：异常自己携带状态码与码，用户无需为此写 handler。
  // help 不进响应——它是给开发者的下一步指引，不是给调用方的。
  if (error instanceof HttpError) {
    return problemResponse(error.status, { detail: error.message, code: error.code });
  }
  if (error instanceof RequestValidationError) {
    return problemResponse(400, {
      code: error.code,
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
  return problemResponse(500, { errorId });
}

export type ErrorDispatcher = (error: unknown, context: RequestContext) => Promise<Response>;

export function createErrorDispatcher(
  // RouteErrorHandler 的 R 已放宽（S3，#275），本分派仍按 S2 语义只吃返回 Response 的
  // 处理器；非 Response 返回的编码路径随 v3 路由表落地。
  handlers: readonly RouteErrorHandler<unknown, Response>[],
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
