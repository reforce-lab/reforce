import { describe, expect, test } from "vitest";
import { errorCodeTables, knownErrorCodes } from "@/explain/code-registry";
import { articleTables, diagnosticArticle } from "@/explain/codes";

// 长文的全量 conformance（ADR 0013 决议 5 收口，#297）：CONTRIBUTING「长文与码同 PR」此前只是
// 纪律条文，存量缺口补齐后由这里机械化——新增一个码而不写长文，第一条断言直接点名它。
// 「已知但无长文」出口（commands/explain.ts）自此只是防御路径，正常构建下不可达。

describe("article coverage over the full code registry", () => {
  test("every registered error code has a long-form article", () => {
    expect(knownErrorCodes().filter((code) => diagnosticArticle(code) === undefined)).toEqual([]);
  });

  // 反方向：表里出现一个没人声明的键，说明码被改名或被删了（与各分表 spec 的同款断言相比，
  // 这里罩住的是全部五张表，包括没有独立 spec 的 compiler 表）。
  test("every article key is a registered error code", () => {
    const declared = new Set(errorCodeTables.flatMap((table) => table.codes));

    expect(
      articleTables.flatMap((table) => Object.keys(table)).filter((code) => !declared.has(code)),
    ).toEqual([]);
  });
});

// explain 的输出是一行一个事实的终端文本（render.ts 头注释），长文正文预先折好行才不会在窄
// 终端上二次折行、把缩进的编号步骤拆散。96 沿用既有分表 spec 的上限，这里罩住全部五张表。
test("pre-wraps every article line across all tables to the shared width", () => {
  const overlong = articleTables.flatMap((table) =>
    Object.entries(table).flatMap(([code, entry]) =>
      entry.article.filter((line) => line.length > 96).map((line) => `${code}: ${line}`),
    ),
  );

  expect(overlong).toEqual([]);
});

// 用户输入直接进查表；五张表合并后原型链成员仍不得命中（codes.ts 用 Object.hasOwn 守卫）。
test("does not resolve a prototype member as an article", () => {
  expect(diagnosticArticle("constructor")).toBeUndefined();
});
