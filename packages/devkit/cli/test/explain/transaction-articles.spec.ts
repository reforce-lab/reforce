import { transactionErrorCodes } from "@reforce/transaction";
import { describe, expect, test } from "vitest";
import { errorCodeTables } from "@/explain/code-registry";
import {
  type DiagnosticArticle,
  diagnosticArticle,
  explainCommandFor,
  renderDiagnosticArticle,
} from "@/explain/codes";
import { transactionArticles } from "@/explain/transaction-articles";

// 事务护栏码的长文（ADR 0013 决议 5 的长文缺口第一批，#297）。断言的是覆盖与查找链路，不是
// 文风：护的是「`reforce explain TRANSACTION_*` 不再落到「暂无长文」出口」这一条。

// 查表 + 断言存在合成一步：测试里要的是那个 DiagnosticArticle，`!` 与 `as` 都是未经校验的
// 断言（overview 的类型纪律），而覆盖本身由下面第一条 test 独立守着。
function articleFor(code: string): DiagnosticArticle {
  const entry = diagnosticArticle(code);
  if (entry === undefined) {
    throw new Error(`No long-form article is registered for ${code}.`);
  }
  return entry;
}

describe("transaction guard articles", () => {
  test("cover every code in the transaction table", () => {
    expect(transactionErrorCodes.filter((code) => diagnosticArticle(code) === undefined)).toEqual(
      [],
    );
  });

  // 与 argument-articles 同款：表里出现一个没人声明的键，说明码被改名或被删了。
  test("do not carry keys that no code table declares", () => {
    const declared = new Set(errorCodeTables.flatMap((table) => table.codes));

    expect(Object.keys(transactionArticles).filter((code) => !declared.has(code))).toEqual([]);
  });

  test("point the diagnostic footer at a live explain command", () => {
    expect(explainCommandFor("TRANSACTION_RESOURCE_REUSED")).toBe(
      "reforce explain TRANSACTION_RESOURCE_REUSED",
    );
  });
});

// 三张表合并查询后（codes.ts 的 articleTables），前两张不能被新来的这张挤掉。
describe("diagnosticArticle over three article tables", () => {
  test("resolves a transaction guard article", () => {
    expect(diagnosticArticle("TRANSACTION_SAVEPOINT_UNSUPPORTED")?.summary).toContain("savepoint");
  });

  test("still resolves a compiler diagnostic article", () => {
    expect(diagnosticArticle("MISSING_BEAN")?.summary).toContain("no provider");
  });

  test("still resolves an argument guard article", () => {
    expect(diagnosticArticle("CORE_INVALID_BEAN_SCOPE")?.summary).toContain("defineBean scope");
  });

  // 用户输入直接进查表；三张表里任何一张都不得让原型链成员命中。
  test("does not resolve a prototype member", () => {
    expect(diagnosticArticle("toString")).toBeUndefined();
  });
});

describe("rendering a transaction guard article", () => {
  test("opens with the code and its summary", () => {
    const entry = articleFor("TRANSACTION_TIMEOUT");

    const lines = renderDiagnosticArticle("TRANSACTION_TIMEOUT", entry);

    expect(lines[0]).toBe(`TRANSACTION_TIMEOUT · ${entry.summary}`);
  });

  test("separates the summary from the body with a blank line", () => {
    const entry = articleFor("TRANSACTION_TIMEOUT");

    const lines = renderDiagnosticArticle("TRANSACTION_TIMEOUT", entry);

    expect(lines[1]).toBe("");
  });

  test("keeps the body lines verbatim after the header", () => {
    const entry = articleFor("TRANSACTION_TIMEOUT");

    const lines = renderDiagnosticArticle("TRANSACTION_TIMEOUT", entry);

    expect(lines.slice(2)).toEqual([...entry.article]);
  });
});

// explain 的输出是一行一个事实的终端文本（render.ts 头注释），长文正文预先折好行才不会在窄
// 终端上二次折行、把缩进的编号步骤拆散。96 是现有两张长文表的实际上限（源码行宽 100 减去
// 缩进与引号），新表跟着走，不另立一套宽度。
test("pre-wraps every transaction article line to the width the other tables use", () => {
  const overlong = Object.entries(transactionArticles).flatMap(([code, entry]) =>
    entry.article.filter((line) => line.length > 96).map((line) => `${code}: ${line}`),
  );

  expect(overlong).toEqual([]);
});
