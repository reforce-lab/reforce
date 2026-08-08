// @reforce/transaction 的错误码表（ADR 0013 决议 2，#289）。每个持有码的包一律把表声明在 src/error-codes.ts：
// 读者找「这个包有哪些码」只有一处要看，@reforce/cli 的 explain/code-registry 也只认这一条路径。
// 数组是唯一真相、union 从它派生——此前 union 与各处的字面量各写各的，删一个成员或写一个不在
// 表里的码 typecheck 都不报。码表不集中到注册包：那会造成反向依赖。
//
// 本包此前连 union 都没有，七个码只以类字面量的形式各写各的，既无闭集可查也无从参与唯一性检查。
export const transactionErrorCodes = [
  "TRANSACTION_SAVEPOINT_UNSUPPORTED",
  "TRANSACTION_ISOLATION_ON_JOIN",
  "TRANSACTION_ISOLATION_UNSUPPORTED",
  "TRANSACTION_TIMEOUT_ON_JOIN",
  "TRANSACTION_TIMEOUT_UNSUPPORTED",
  "TRANSACTION_TIMEOUT",
  "TRANSACTION_RESOURCE_REUSED",
] as const;

export type TransactionErrorCode = (typeof transactionErrorCodes)[number];
