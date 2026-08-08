import { cliFailureCodes } from "@reforce/runtime/error-codes";
import { describe, expect, test } from "vitest";
import { cliArticles } from "@/explain/cli-articles";
import { diagnosticArticle } from "@/explain/codes";

// CLI 失败码长文表（#297 收口批）。断言的是表的归属边界与查找链路，不是文风；全量覆盖、键
// 合法性与行宽由 codes.spec 对五张表统一断言。

describe("cli articles table ownership", () => {
  // 本表与 cliFailureCodes 一一对应：reporter 的失败码词汇表就是 explain 在这一域的全部面。
  test("carries exactly the cli failure codes", () => {
    expect(Object.keys(cliArticles).sort()).toEqual([...cliFailureCodes].sort());
  });

  test("resolves a cli failure article through the merged lookup", () => {
    expect(diagnosticArticle("PROJECT_BUSY")?.summary).toContain("lease");
  });

  // 两个目录事务码是同一个类、同一套 journal 协议（directory-transaction.ts），共用正文；
  // summary 仍逐码一句——正文共享是刻意决策，防回归。
  test("shares one body between the two directory transaction codes", () => {
    expect(diagnosticArticle("GENERATED_TRANSACTION_FAILED")?.article).toBe(
      diagnosticArticle("DIST_TRANSACTION_FAILED")?.article,
    );
  });
});
