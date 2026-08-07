import { expect, test } from "vitest";
import * as generatedRuntime from "@/generated-runtime";
import * as publicTransaction from "@/index";

test("the root entry exposes only the public transaction contract", () => {
  expect(Object.keys(publicTransaction).sort()).toEqual([
    "TransactionIsolationOnJoinError",
    "TransactionIsolationUnsupportedError",
    "TransactionResourceReusedError",
    "TransactionSavepointUnsupportedError",
    "TransactionTimeoutError",
    "TransactionTimeoutOnJoinError",
    "TransactionTimeoutUnsupportedError",
    "Transactional",
    "activeResourceFor",
    "isNestedTransactionManager",
    "runTransactional",
    "transactionErrorCodes",
    "transactionIsolationLevels",
  ]);
});

test("the generated entry exposes only the synthesized interceptor", () => {
  expect(Object.keys(generatedRuntime).sort()).toEqual(["TransactionInterceptor"]);
});
