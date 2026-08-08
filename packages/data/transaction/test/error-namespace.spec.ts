import { expect, test } from "vitest";
import { errors } from "@/index";

// 七个事务护栏错误（ADR 0013 决议 8，#296）：它们报的都是「你的 TransactionManager 不满足
// 这条契约」，用户的兜底拦截器必须放行（#246 决议 5），因此最需要被程序化识别。
test("the errors namespace exposes all seven transaction guards", () => {
  expect(Object.keys(errors).sort()).toEqual([
    "TransactionIsolationOnJoinError",
    "TransactionIsolationUnsupportedError",
    "TransactionResourceReusedError",
    "TransactionSavepointUnsupportedError",
    "TransactionTimeoutError",
    "TransactionTimeoutOnJoinError",
    "TransactionTimeoutUnsupportedError",
  ]);
});
