import { describe, expect, test } from "vitest";
import { cliErrorCodes } from "@/error-codes";
import {
  cliOwnedErrorCodes,
  errorCodeDomain,
  errorCodeTables,
  isKnownErrorCode,
  knownErrorCodes,
} from "@/explain/code-registry";

// 码表的 conformance（ADR 0013 决议 2，#289）。护的是一条撞了才知道的不变量：两个包各自造出
// 同名码，`reforce explain <CODE>` 会答非所问、`--diagnostic-level <CODE>=off` 会误伤另一个
// 概念、按 code 分派的用户代码会静默走错分支——全都要到用户报障才暴露。
describe("the error code registry", () => {
  test("每张表内部没有重复", () => {
    const duplicated = errorCodeTables.flatMap((table) =>
      table.codes
        .filter((code, index) => table.codes.indexOf(code) !== index)
        .map((code) => `${table.domain}:${code}`),
    );

    expect(duplicated).toEqual([]);
  });

  test("跨表没有同码不同义", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const table of errorCodeTables) {
      for (const code of table.codes) {
        const owner = seen.get(code);
        if (owner === undefined) {
          seen.set(code, table.domain);
          continue;
        }
        collisions.push(`${code} claimed by both ${owner} and ${table.domain}`);
      }
    }

    expect(collisions).toEqual([]);
  });

  // 两张 CLI 表是同一概念的两侧而不是两个所有者：CLI 错误抛出去之后就是 reporter 的失败码。
  // 漂移的后果是那条错误报出一个 reporter 词汇表里没有的码，json 消费方读到未知值。
  test("CliErrorCode 完整包含在 CliFailureCode 里", () => {
    const failureCodes = new Set(
      errorCodeTables.find((table) => table.domain === "cli")?.codes ?? [],
    );

    expect(cliOwnedErrorCodes.filter((code) => !failureCodes.has(code))).toEqual([]);
  });

  test("每张表都非空", () => {
    expect(errorCodeTables.filter((table) => table.codes.length === 0)).toEqual([]);
  });
});

describe("errorCodeDomain", () => {
  test("把码归到声明它的域", () => {
    expect(errorCodeDomain("MISSING_BEAN")).toBe("compiler");
  });

  test("对没人认领的码返回 undefined", () => {
    expect(errorCodeDomain("NOT_A_REAL_CODE")).toBeUndefined();
  });

  // 用户输入直接进查表，原型链上的成员不得被当成命中（同 explain/codes.ts 的 Object.hasOwn）。
  test("不把原型链成员当成已知码", () => {
    expect(isKnownErrorCode("constructor")).toBe(false);
  });
});

test("knownErrorCodes 覆盖每张表且已排序", () => {
  const known = knownErrorCodes();

  expect(known).toEqual([...new Set(errorCodeTables.flatMap((table) => table.codes))].sort());
});

test("CLI 子树的码表与它的错误类闭集一致", () => {
  expect([...cliErrorCodes].sort()).toEqual([
    "ARTIFACT_INVALID",
    "DIST_TRANSACTION_FAILED",
    "GENERATED_TRANSACTION_FAILED",
    "PROJECT_BUSY",
  ]);
});
