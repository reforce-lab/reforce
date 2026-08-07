import { defineHttpError } from "@reforce/web";

// 模块专属异常：只有 greeting 会抛它，所以它就住在 greeting 这个目录里。判据和别处一样——
// 改「什么算重复」这条规则时要动的文件，都在同一个目录。
//
// defineHttpError 一行定义一个业务异常：码、消息模板、状态码写在一处，抛的时候只填参数。
// 框架的 error-dispatch 直接把它翻译成 RFC 9457 problem+json，**不需要你写错误处理器**，
// 也不需要维护一张「异常 → 状态码」的表。
//
// 码是给调用方按程序分派用的（响应体里的 `code` 字段），所以它属于你的 API 契约：一旦发布
// 就别再改名。消息可以随时改——那是给人读的。
//
// 通用的 404 / 401 / 403 / 409 不用自己定义，`@reforce/web` 直接导出了 NotFoundError、
// UnauthorizedError、ForbiddenError、ConflictError、BadRequestError。
export const GreetingAlreadyExists = defineHttpError<[name: string]>(
  "GREETING_ALREADY_EXISTS",
  "已经有名为 %s 的问候语了。",
  409,
);
