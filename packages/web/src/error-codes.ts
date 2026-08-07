// @reforce/web 的错误码表（ADR 0013 决议 2，#289）。每个持有码的包一律把表声明在 src/error-codes.ts：
// 读者找「这个包有哪些码」只有一处要看，@reforce/cli 的 explain/code-registry 也只认这一条路径。
// 数组是唯一真相、union 从它派生——此前 union 与各处的字面量各写各的，删一个成员或写一个不在
// 表里的码 typecheck 都不报。码表不集中到注册包：那会造成反向依赖。
export const webErrorCodes = [
  "INVALID_ROUTE_TABLE",
  "MIDDLEWARE_REENTERED",
  "REQUEST_VALIDATION_FAILED",
  "RESPONSE_SERIALIZATION_FAILED",
  // 面向用户的 HTTP 异常原语（ADR 0013 决议 6，#294）。带 WEB_ 前缀是决议 2 对**框架自己**
  // 新增的码的要求；用户经 defineHttpError 起的码不带前缀，也不进本表——那个命名空间是
  // 用户的。上面四个存量码一律不改名。
  "WEB_BAD_REQUEST",
  "WEB_UNAUTHORIZED",
  "WEB_FORBIDDEN",
  "WEB_NOT_FOUND",
  "WEB_CONFLICT",
] as const;

export type WebErrorCode = (typeof webErrorCodes)[number];
