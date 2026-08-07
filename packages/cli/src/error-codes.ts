// @reforce/cli 的错误码表（ADR 0013 决议 2，#289）。每个持有码的包一律把表声明在 src/error-codes.ts：
// 读者找「这个包有哪些码」只有一处要看，@reforce/cli 的 explain/code-registry 也只认这一条路径。
// 数组是唯一真相、union 从它派生——此前 union 与各处的字面量各写各的，删一个成员或写一个不在
// 表里的码 typecheck 都不报。码表不集中到注册包：那会造成反向依赖。
//
// 只收「会越过 CLI 边界抵达用户」的错误。纯包内控制流信号（TreeShapeError、
// DiagnosticLevelSyntaxError、TerminationRequestedError）维持裸 Error 且不进表：它们从不出边界，
// 给它们编码等于往稳定码表里塞永远不会被用户查到的条目（对齐 rustc「简单错误不设码」）。
export const cliErrorCodes = [
  "ARTIFACT_INVALID",
  "PROJECT_BUSY",
  "GENERATED_TRANSACTION_FAILED",
  "DIST_TRANSACTION_FAILED",
] as const;

export type CliErrorCode = (typeof cliErrorCodes)[number];
