import { compilerDiagnosticCodes } from "@reforce/compiler";
import { describe, expect, test } from "vitest";
import {
  compilerArticles,
  type DiagnosticArticle,
  diagnosticArticle,
  explainCommandFor,
} from "@/explain/codes";

// compiler 诊断长文表的 spec（评审缺陷 A2，#314）。三张长文表里此前唯一没有 spec 的就是这张，
// 于是 MISSING_BEAN 的长文把 `reforce lib` 的库导出约束（LIBRARY_EXPORT_MISMATCH）误植到了
// 应用编译上，声称「编译器只看从应用入口（传递）导出的类」——与实现相反：source discovery
// 消费 leaf tsconfig include 展开的全部源文件（compiler/src/project/source-files.ts），
// provider 无需被任何文件 import 或 re-export（compiler 的 it/source-discovery.spec 钉死了
// 这一行为）。这里除结构断言外，还对长文的关键事实陈述做正/负向断言，防止误述回潮。

// 查表 + 断言存在合成一步：`!` 与 `as` 都是未经校验的断言（overview 的类型纪律），覆盖本身
// 由下面的结构断言独立守着。
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

describe("compiler diagnostic articles", () => {
  // 与 argument-articles / transaction-articles 同款：表里出现一个 compiler 码表没声明的键，
  // 说明码被改名或被删了。
  test("carry only keys the compiler code table declares", () => {
    const declared = new Set<string>(compilerDiagnosticCodes);

    expect(Object.keys(compilerArticles).filter((code) => !declared.has(code))).toEqual([]);
  });

  test("point the diagnostic footer at a live explain command", () => {
    expect(explainCommandFor("MISSING_BEAN")).toBe("reforce explain MISSING_BEAN");
  });
});

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

// explain 的输出是一行一个事实的终端文本（render.ts 头注释），长文正文预先折好行才不会在窄
// 终端上二次折行。96 与另两张表的上限一致（transaction-articles.spec 同款断言）。
test("pre-wraps every compiler article line to the width the other tables use", () => {
  const overlong = Object.entries(compilerArticles).flatMap(([code, entry]) =>
    entry.article.filter((line) => line.length > 96).map((line) => `${code}: ${line}`),
  );

  expect(overlong).toEqual([]);
});
