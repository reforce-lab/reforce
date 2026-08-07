// @reforce/core 的错误码表（ADR 0013 决议 2，#289）。每个持有码的包一律把表声明在 src/error-codes.ts：
// 读者找「这个包有哪些码」只有一处要看，@reforce/cli 的 explain/code-registry 也只认这一条路径。
// 数组是唯一真相、union 从它派生——此前 union 与各处的字面量各写各的，删一个成员或写一个不在
// 表里的码 typecheck 都不报。码表不集中到注册包：那会造成反向依赖。
//
// 它不是「全框架的码表」，只是容器自己的闭集——框架包各自持有自己的码，因此 ReforceError 的
// 类型参数上界只能是 string，跨包的码由各自的类字面量声明（ADR 0009 起 CLI 侧就按 string 消费）。
export const coreErrorCodes = [
  "EARLY_BEAN_ACCESS",
  "BEAN_CREATION_FAILED",
  "BEAN_LIFECYCLE_FAILED",
  "BEAN_DISPOSAL_FAILED",
  "APPLICATION_START_FAILED",
  "APPLICATION_CLEANUP_FAILED",
  "CONFIG_BINDING_FAILED",
  "REQUEST_CONTEXT_MISSING",
  "UNREGISTERED_BEAN_TARGET",
  "APPLICATION_CONTEXT_STATE",
  "INVALID_GENERATED_DEFINITION",
  "INTERCEPTOR_REENTERED",
] as const;

export type CoreErrorCode = (typeof coreErrorCodes)[number];
