// `errors` 命名空间（ADR 0013 决议 8，#296）。七个事务护栏错误——它们报的都是「你的
// TransactionManager 不满足这条契约」，用户的兜底拦截器必须放行（#246 决议 5），因此
// 也是最需要被程序化识别的一批。
export {
  TransactionIsolationOnJoinError,
  TransactionIsolationUnsupportedError,
  TransactionResourceReusedError,
  TransactionSavepointUnsupportedError,
  TransactionTimeoutError,
  TransactionTimeoutOnJoinError,
  TransactionTimeoutUnsupportedError,
} from "@/errors";
