import { describe, expect, test } from "vitest";
import { argumentArticles } from "@/explain/argument-articles";
import { errorCodeTables } from "@/explain/code-registry";
import { diagnosticArticle, explainCommandFor } from "@/explain/codes";

// CONTRIBUTING 的纪律：新增任何错误码，长文与码同 PR。护的是「`reforce explain <CODE>` 不能
// 是死路」，所以这里断言的是覆盖，不是文风。
describe("argument guard articles", () => {
  const guardCodes = errorCodeTables
    .flatMap((table) => table.codes)
    .filter(
      (code) => code.startsWith("CORE_") || code.startsWith("CONFIG_") || code.startsWith("WEB_"),
    );

  test("cover every prefixed framework code", () => {
    expect(guardCodes.filter((code) => diagnosticArticle(code) === undefined)).toEqual([]);
  });

  test("do not carry keys that no code table declares", () => {
    const declared = new Set(errorCodeTables.flatMap((table) => table.codes));

    expect(Object.keys(argumentArticles).filter((code) => !declared.has(code))).toEqual([]);
  });

  test("point the diagnostic footer at a live explain command", () => {
    expect(explainCommandFor("CORE_MISSING_BEAN_FACTORY")).toBe(
      "reforce explain CORE_MISSING_BEAN_FACTORY",
    );
  });
});

describe("diagnosticArticle", () => {
  // 两张表合并查询后，compiler 那张不能被挤掉。
  test("still resolves a compiler diagnostic article", () => {
    expect(diagnosticArticle("MISSING_BEAN")?.summary).toContain("no provider");
  });

  test("resolves an argument guard article", () => {
    expect(diagnosticArticle("CORE_INVALID_BEAN_SCOPE")?.summary).toContain("defineBean scope");
  });

  // 用户输入直接进查表；原型链成员不得命中（合表后两张表都要守住这条）。
  test("does not resolve a prototype member", () => {
    expect(diagnosticArticle("constructor")).toBeUndefined();
  });

  test("returns undefined for an unknown code", () => {
    expect(diagnosticArticle("NOT_A_REAL_CODE")).toBeUndefined();
  });
});
