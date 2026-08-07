// @reforce/web 的错误码表（ADR 0013 决议 2，#289）。每个持有码的包一律把表声明在 src/error-codes.ts：
// 读者找「这个包有哪些码」只有一处要看，@reforce/cli 的 explain/code-registry 也只认这一条路径。
// 数组是唯一真相、union 从它派生——此前 union 与各处的字面量各写各的，删一个成员或写一个不在
// 表里的码 typecheck 都不报。码表不集中到注册包：那会造成反向依赖。
export const webErrorCodes = [
  "INVALID_ROUTE_TABLE",
  "MIDDLEWARE_REENTERED",
  "REQUEST_VALIDATION_FAILED",
  "RESPONSE_SERIALIZATION_FAILED",
] as const;

export type WebErrorCode = (typeof webErrorCodes)[number];
