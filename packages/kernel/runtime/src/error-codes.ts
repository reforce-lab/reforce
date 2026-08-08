// @reforce/runtime 的错误码表（ADR 0013 决议 2，#289）。每个持有码的包一律把表声明在 src/error-codes.ts：
// 读者找「这个包有哪些码」只有一处要看，@reforce/cli 的 explain/code-registry 也只认这一条路径。
// 数组是唯一真相、union 从它派生——此前 union 与各处的字面量各写各的，删一个成员或写一个不在
// 表里的码 typecheck 都不报。码表不集中到注册包：那会造成反向依赖。
//
// 它是 reporter 打给用户的失败码词汇表，因此把 CLI 子树的四个错误码逐字包含在内——CLI 错误抛
// 出去之后就是这里的失败码，两张表是同一概念的两侧（包含关系由 code-registry 的 conformance 断言）。
export const cliFailureCodes = [
  "CLI_USAGE_ERROR",
  "PACKAGE_EXPORTS_INVALID",
  "STARTER_META_OUT_OF_DATE",
  "PROJECT_BUSY",
  "GENERATED_TRANSACTION_FAILED",
  "DIST_TRANSACTION_FAILED",
  "BUILD_FAILED",
  "ARTIFACT_INVALID",
  "BOOTSTRAP_FAILED",
  "HMR_FATAL",
  "CHILD_FAILED",
  "SHUTDOWN_FAILED",
  "UNCAUGHT_EXCEPTION",
] as const;

export type CliFailureCode = (typeof cliFailureCodes)[number];
