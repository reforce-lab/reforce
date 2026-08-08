import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { RequestValidationError, ResponseSerializationError } from "@/errors";
import type { RequestContext } from "@/execution/request-context";
import { currentRequestId } from "@/execution/request-fields";
import { jsonResponse } from "@/execution/serialization";
import type { ErrorLogger } from "@/execution/web-application";
import { HttpError } from "@/http-errors";
import type { RouteErrorHandler } from "@/routing/middleware";

// 错误分派（ADR 0006 W4 待打磨项定案，#152 / RFC 0012 S3，#275）：按路由表写死的顺序逐条
// 尝试——accepts 存在时先过 instanceof 闸;handle 返回 Response 即接管(S2 win 条件);返回
// 非 Response 且该条声明了 status,按编码路径出线;否则换成 ResponseSerializationError 继续
// 升级。(重新)throw 把抛出的错误交给下一条(换错即升级,原错不再保留;升级错误会被后续
// typed 处理器重新过闸)。全部放弃后进框架默认兜底。分派器对调用方的保证:永不 reject。
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
function problemResponse(problem: ProblemDescription): Response {
  const body = {
    type: "about:blank",
    title: STATUS_CODES[problem.status] ?? "Error",
    status: problem.status,
    ...problem.members,
  };
  // content-length 同 serialization.ts 的 jsonResponse：适配器据它选 Buffer / 流路径
  // （见 adapter.ts 的契约块）。长度取字节数，文案可以带非 ASCII。
  const bytes = encoder.encode(JSON.stringify(body));
  return new Response(bytes, {
    status: problem.status,
    headers: {
      "content-type": "application/problem+json",
      "content-length": String(bytes.byteLength),
    },
  });
}

/** 兜底三分支的判定结果：status + RFC 9457 扩展成员。 */
export interface ProblemDescription {
  readonly status: number;
  readonly members: Readonly<Record<string, unknown>>;
}

// 兜底判定的单一事实源（#279）：JSON 与 dev 错误页两条呈现路径共享同一份 status/members，
// 两边永不漂移。500 分支的 errorId 生成与日志留在判定内——无论哪种呈现，日志与客户端拿到的
// 都是同一个 id。
//
// 500 兜底（RFC 0011 C1，#250）。此前是 `new Response(undefined, { status: 500 })`——错误
// **完全被吞掉**：不打日志，客户端也拿不到任何线索，运维只能靠时间戳猜是哪一条。
//
// errorId 与 request id 解耦：它只在 500 真的发生时生成，常态零开销（randomUUID 不在热路径
// 上），而排查价值最大的场景照样覆盖——用户报一个 id，日志里一次 grep 就到现场。
//
// **栈与 message 绝不进 5xx 响应**：栈里有源码路径、依赖版本，message 里常有表名和内部 ID。
// 响应只带 errorId，栈进日志——两者由同一个 id 关联。明确不学 Fastify 5 的默认 500 回显
// error.message。
function describeProblem(error: unknown, logger: ErrorLogger | undefined): ProblemDescription {
  // 用户异常原语（决议 6）：异常自己携带状态码与码，用户无需为此写 handler。
  // help 不进响应——它是给开发者的下一步指引，不是给调用方的。
  if (error instanceof HttpError) {
    return { status: error.status, members: { detail: error.message, code: error.code } };
  }
  if (error instanceof RequestValidationError) {
    return {
      status: 400,
      members: {
        code: error.code,
        source: error.source,
        issues: error.issues.map((issue) => ({ message: issue.message, path: issue.path })),
      },
    };
  }
  const errorId = randomUUID();
  // 日志失败不得把响应带下去：dispatchError 永不 reject 是适配器契约的一部分（#226），
  // 而 logger 是用户的——serializer 与 LogFieldSource.fields() 都可能抛。
  try {
    // requestId 与 errorId 并存自动关联(#303/#250):500 响应头带 requestId、body 带 errorId,
    // 这条记录把两串字符对上。请求作用域外(理论不可达)不写空键。
    const requestId = currentRequestId();
    logger?.error(
      { errorId, ...(requestId === undefined ? {} : { requestId }), err: error },
      "unhandled error",
    );
  } catch {
    // 记不上就记不上，客户端仍拿到 errorId，只是这次日志里没有对应现场。
  }
  return { status: 500, members: { errorId } };
}

// dev 错误页旗标（#279 两层门的内层）：由 @reforce/runtime 的 dev-runtime 启动时设置，
// web 自己零 env 读取。dev-runtime 只存在于 CLI 的 dev bundle，所以第三方打包器不折叠
// NODE_ENV、或生产误设 NODE_ENV=development 时，旗标根本无人设置——错误页构造性关闭。
// Symbol.for 走全局注册表：web 与 runtime 是两个包，模块作用域的 Symbol() 互不相等；
// 键字面量必须与 runtime/src/dev-runtime.ts 的设置侧一致。
function devErrorPageEnabled(): boolean {
  return Reflect.get(globalThis, Symbol.for("reforce.devErrorPage")) === true;
}

// 协商（#279）：Accept 含 text/html 子串即认（Nitro 同款判据）。不解析 q 值——
// `text/html;q=0` 会被误判成想要 HTML，但发这种头的客户端极罕见，q 值解析器的复杂度与
// 出错面大于收益。HEAD 一律走 JSON：响应体不会被读，渲染是纯浪费。
function wantsHtml(request: Request): boolean {
  if (request.method === "HEAD") {
    return false;
  }
  return request.headers.get("accept")?.includes("text/html") === true;
}

async function fallbackResponse(
  error: unknown,
  context: RequestContext,
  logger: ErrorLogger | undefined,
): Promise<Response> {
  const problem = describeProblem(error, logger);
  // dev 错误页两层门（#279）。外层 NODE_ENV 判断的字面量必须内联在 if 里，禁止提成模块级
  // 常量：CLI 生产构建把 process.env.NODE_ENV 折叠成 "production" 后，整块变成死代码物理
  // 消失（「生产不含渲染器」承诺的第一道闸，第二道见 cli production-dist 的 stub 替换）；
  // 提成常量会挡住折叠。单测 NODE_ENV=test 天然为真，无需 stubEnv。
  if (process.env.NODE_ENV !== "production") {
    if (devErrorPageEnabled() && wantsHtml(context.request)) {
      try {
        // 动态 import：渲染器及其依赖只在第一次命中时加载，不进 dev 启动路径。
        const { renderDevErrorPage } = await import("@/execution/dev-error-page");
        return await renderDevErrorPage({ error, context, problem });
      } catch {
        // 渲染器任何故障（含模块缺失、渲染中途抛错）都降级回 problem+json：dispatchError
        // 永不 reject 是适配器契约（#226），错误页是增强，不是义务。
      }
    }
  }
  return problemResponse(problem);
}

export type ErrorDispatcher = (error: unknown, context: RequestContext) => Promise<Response>;

// v3 表的分派条目(#275):accepts/status/encode 从 GeneratedRouteErrorHandler 原样带入,
// handler 是容器解析出的 bean 实例。
export interface ErrorDispatchEntry {
  readonly handler: RouteErrorHandler;
  readonly accepts?: abstract new (...args: never[]) => object;
  readonly status?: number;
  readonly encode?: (value: unknown) => unknown;
}

function encodedHandlerResponse(
  entry: ErrorDispatchEntry,
  status: number,
  result: unknown,
): Response {
  return jsonResponse(status, entry.encode === undefined ? result : entry.encode(result));
}

export function createErrorDispatcher(
  entries: readonly ErrorDispatchEntry[],
  logger?: ErrorLogger,
): ErrorDispatcher {
  return async (error, context) => {
    let current = error;
    for (const entry of entries) {
      if (entry.accepts !== undefined && !(current instanceof entry.accepts)) {
        continue;
      }
      try {
        const result = await entry.handler.handle(current, context);
        if (result instanceof Response) {
          return result;
        }
        if (entry.status !== undefined) {
          return encodedHandlerResponse(entry, entry.status, result);
        }
        // match-all/passthrough 处理器返回了非 Response 值:没有声明的状态码与形状,无法
        // 编码出线——换成 ResponseSerializationError 继续升级(#275)。
        current = new ResponseSerializationError(
          "an error handler returned a non-Response value without a declared @ResponseStatus.",
        );
      } catch (next) {
        current = next;
      }
    }
    return await fallbackResponse(current, context, logger);
  };
}
