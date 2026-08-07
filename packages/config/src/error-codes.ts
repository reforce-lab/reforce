// @reforce/config 的错误码表（ADR 0013 决议 2，#289）。每个持有码的包一律把表声明在 src/error-codes.ts：
// 读者找「这个包有哪些码」只有一处要看，@reforce/cli 的 explain/code-registry 也只认这一条路径。
// 数组是唯一真相、union 从它派生——此前 union 与各处的字面量各写各的，删一个成员或写一个不在
// 表里的码 typecheck 都不报。码表不集中到注册包：那会造成反向依赖。
//
// 本包此前一个码都没有：四处失败全是裸 TypeError（ADR 0013 决议 3，#292）。全部是新码，
// 因此一律带 CONFIG_ 前缀。
export const configErrorCodes = [
  "CONFIG_INVALID_PROPERTIES_PREFIX",
  "CONFIG_INVALID_PROPERTIES_SCHEMA",
  "CONFIG_MISSING_PROPERTIES_BASE",
  "CONFIG_INVALID_SCHEMA_OUTPUT",
] as const;

export type ConfigErrorCode = (typeof configErrorCodes)[number];
