import { describe, expect, test } from "vitest";
import { errorCodeTables, knownErrorCodes } from "@/explain/code-registry";
import { articleTables, type DiagnosticArticle, diagnosticArticle } from "@/explain/codes";

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

// ——以下为关键事实陈述的正/负向断言（评审缺陷 A2，#314）。compiler 表长期没有内容 spec，
// MISSING_BEAN 的长文把 `reforce lib` 的库导出约束（LIBRARY_EXPORT_MISMATCH）误植到了应用
// 编译上，声称「编译器只看从应用入口（传递）导出的类」——与实现相反：source discovery 消费
// leaf tsconfig include 展开的全部源文件（compiler/src/project/source-files.ts），provider
// 无需被任何文件 import 或 re-export（compiler 的 it/source-discovery.spec 钉死了这一行为）。
// 覆盖类断言由上面的全量 conformance 承担，这里只防误述回潮。

// 查表 + 断言存在合成一步：`!` 与 `as` 都是未经校验的断言（overview 的类型纪律），覆盖本身
// 由上面的 conformance 独立守着。
function articleFor(code: string): DiagnosticArticle {
  const entry = diagnosticArticle(code);
  if (entry === undefined) {
    throw new Error(`No long-form article is registered for ${code}.`);
  }
  return entry;
}

function articleText(code: string): string {
  const entry = articleFor(code);
  return [entry.summary, ...entry.article].join("\n");
}

describe("MISSING_BEAN article states the real discovery rule", () => {
  test("points the first check at the tsconfig source set", () => {
    expect(articleText("MISSING_BEAN")).toContain("tsconfig");
  });

  // 负向：不得复活「从入口导出才可见 / 不可达」的误述。那套规则只属于 `reforce lib` 的
  // 库导出面（LIBRARY_EXPORT_MISMATCH），应用编译从未有过入口可达性过滤。
  test("does not claim providers must be exported to be seen", () => {
    const text = articleText("MISSING_BEAN");

    expect(text).not.toMatch(/reachable/i);
    expect(text).not.toMatch(/application entry/i);
    expect(text).not.toMatch(/re-exports is invisible/i);
  });
});

// 跨全表绊线：同一误解在 #312 的存量补齐里被独立复写过一次（UNREGISTERED_BEAN_TARGET 曾称
// 类要「reachable from the application entry」才被编译）。逐篇断言追不上五张表的增长，这里
// 按措辞全表拦截；合法的「entry point」（dist 入口、runtime 入口）不含此短语，不会误伤。
test("no article claims anything must be reachable from the application entry", () => {
  const offending = articleTables.flatMap((table) =>
    Object.entries(table)
      .filter(([, entry]) =>
        /from the application entry/iu.test([entry.summary, ...entry.article].join("\n")),
      )
      .map(([code]) => code),
  );

  expect(offending).toEqual([]);
});

describe("BEAN_ID_COLLISION article states the real collision rule", () => {
  test("explains the collision as case-insensitive id folding", () => {
    expect(articleText("BEAN_ID_COLLISION")).toMatch(/case/i);
  });

  // 负向：旧文声称「file name 不参与 id、挪文件没用」，与实现相反——id 就是
  // `项目相对路径#导出名`（compiler/src/analysis/model.ts 的 providerId）。
  test("does not claim the file name is outside the id", () => {
    const text = articleText("BEAN_ID_COLLISION");

    expect(text).not.toMatch(/file name is not part of the id/i);
    expect(text).not.toMatch(/reached the entry/i);
  });
});
