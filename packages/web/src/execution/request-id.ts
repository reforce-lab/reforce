import { randomUUID } from "node:crypto";

// request id 开箱件(#303):零配置默认开启的框架内建行为,不是中间件——真中间件看不到
// 中间件自身抛错后的外层兜底响应,全出口唯一收敛点是 web-application 的统一缝。头名固定;
// 定制与 traceparent 传播属未来 RFC。
//
// 边界:引擎级 404 不进 handle,不盖章不记 id(与 L6 请求日志同边界)。

export const requestIdHeader = "x-request-id";

// 回显闸:仅可见 ASCII、长度 1–128。头值可完全由客户端控制,放行控制字符/超长值等于让
// 任意调用方向日志与响应头注入垃圾;不合法就当没给,重新生成。
const validRequestId = /^[\x21-\x7e]{1,128}$/;

export function resolveRequestId(request: Request): string {
  const provided = request.headers.get(requestIdHeader);
  if (provided !== null && validRequestId.test(provided)) {
    return provided;
  }
  return randomUUID();
}
