import { randomUUID } from "node:crypto";
import type { IncomingRequest } from "@/execution/incoming-request";

// request id 开箱件(#303):零配置默认开启的框架内建行为,不是中间件——真中间件看不到
// 中间件自身抛错后的外层兜底响应,全出口唯一收敛点是 web-application 的统一缝。头名固定;
// 定制与 traceparent 传播属未来 RFC。
//
// 边界:引擎级 404 不进 handle,不盖章不记 id(与 L6 请求日志同边界)。

export const requestIdHeader = "x-request-id";

// 回显闸:仅可见 ASCII、长度 1–128。头值可完全由客户端控制,放行控制字符/超长值等于让
// 任意调用方向日志与响应头注入垃圾;不合法就当没给,重新生成。
const validRequestId = /^[\x21-\x7e]{1,128}$/;

// 收 IncomingRequest 而不是 Request（#341）：这是**每请求必然执行**的一次读头，走
// `request.headers.get()` 就会把整个 Headers 物化，惰性化因此全部白做——hono 的 Request 早就
// 是惰性 Proxy 了，仍然被这一行读成全量 Headers（profile 里它的 undici 桶还占 9.4%）。
export function resolveRequestId(request: IncomingRequest): string {
  const provided = request.header(requestIdHeader);
  if (provided !== null && validRequestId.test(provided)) {
    return provided;
  }
  return randomUUID();
}
