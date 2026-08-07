import { describe, expect, test } from "vitest";
import type { CompilerDiagnostic, CompilerDiagnosticCode } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { CanonicalFileId, SourceSpan } from "@/parser/source-location";
import type { SuppressionComment } from "@/parser/suppressions";
import { applySuppressions } from "@/suppressions";

// 抑制求值（RFC 0011 D7，#242）。这里测的是判定本身，不经 parse、不起临时项目——
// IT 里那条端到端只覆盖了「一条抑制压住一条 warning」这一种形状。

function span(file: string, line: number): SourceSpan {
  return {
    fileId: file as CanonicalFileId, // 测试构造的相对路径本就满足 canonical 文法 // justified: 品牌只记录该校验
    start: { offset: 0, line, character: 0 },
    end: { offset: 1, line, character: 1 },
  };
}

function warning(code: CompilerDiagnosticCode, file: string, line: number): CompilerDiagnostic {
  return diagnostic({ code, severity: "warning", message: code, sourceSpan: span(file, line) });
}

function error(code: CompilerDiagnosticCode, file: string, line: number): CompilerDiagnostic {
  return diagnostic({ code, message: code, sourceSpan: span(file, line) });
}

function suppression(code: string, line: number): SuppressionComment {
  return {
    kind: "suppression",
    code,
    explanation: "because",
    span: span("a.ts", line),
    targetLine: line + 1,
  };
}

function codesOf(input: {
  readonly diagnostics: readonly CompilerDiagnostic[];
}): readonly string[] {
  return input.diagnostics.map((item) => item.code).toSorted();
}

describe("applySuppressions", () => {
  test("drops a warning reported on the line the comment points at", () => {
    const result = applySuppressions(
      [warning("DUPLICATE_ROUTE", "a.ts", 4)],
      [{ fileId: "a.ts", suppressions: [suppression("DUPLICATE_ROUTE", 3)] }],
    );

    expect(codesOf(result)).toEqual([]);
  });

  test("leaves a warning reported on any other line alone", () => {
    const result = applySuppressions(
      [warning("DUPLICATE_ROUTE", "a.ts", 9)],
      [{ fileId: "a.ts", suppressions: [suppression("DUPLICATE_ROUTE", 3)] }],
    );

    expect(codesOf(result)).toEqual(["DUPLICATE_ROUTE", "UNUSED_SUPPRESSION"]);
  });

  // 抑制按 fileId 匹配，不只按行号——两个文件的第 4 行是两回事。
  test("does not reach across files", () => {
    const result = applySuppressions(
      [warning("DUPLICATE_ROUTE", "b.ts", 4)],
      [{ fileId: "a.ts", suppressions: [suppression("DUPLICATE_ROUTE", 3)] }],
    );

    expect(codesOf(result)).toEqual(["DUPLICATE_ROUTE", "UNUSED_SUPPRESSION"]);
  });

  test("leaves a warning whose code differs alone", () => {
    const result = applySuppressions(
      [warning("DUPLICATE_ROUTE", "a.ts", 4)],
      [{ fileId: "a.ts", suppressions: [suppression("INVALID_ROUTE_MARKER", 3)] }],
    );

    expect(codesOf(result)).toEqual(["DUPLICATE_ROUTE", "UNUSED_SUPPRESSION"]);
  });

  // error 不可抑制：分析没能产出完整的图，emission 会照着它发射实参缺失的构造调用。
  test("refuses to suppress an error and says so", () => {
    const result = applySuppressions(
      [error("MISSING_BEAN", "a.ts", 4)],
      [{ fileId: "a.ts", suppressions: [suppression("MISSING_BEAN", 3)] }],
    );

    expect(codesOf(result)).toEqual(["MISSING_BEAN", "SUPPRESSION_NOT_APPLICABLE"]);
  });

  test("reports a suppression that matched nothing", () => {
    const result = applySuppressions(
      [],
      [{ fileId: "a.ts", suppressions: [suppression("NOT_A_REAL_CODE", 3)] }],
    );

    expect(codesOf(result)).toEqual(["UNUSED_SUPPRESSION"]);
  });

  // 两条抑制压同一行同一码：都算 used。第二条不是「多余」——删掉任何一条，那条 warning 仍被
  // 压住，判它 unused 会让人删错。
  test("counts every suppression that matched, not just the first", () => {
    const result = applySuppressions(
      [warning("DUPLICATE_ROUTE", "a.ts", 4)],
      [
        {
          fileId: "a.ts",
          suppressions: [suppression("DUPLICATE_ROUTE", 3), suppression("DUPLICATE_ROUTE", 3)],
        },
      ],
    );

    expect(codesOf(result)).toEqual([]);
  });
});

// 自产两条诊断不可被抑制注释压（见 suppressions.ts 顶部）。允许压它们就等于允许
// 「E1 是否 used」取决于「E2 是否 used」，两条互指的抑制因此有两个同样自洽的解。
describe("the suppression stage's own diagnostics are not suppressible", () => {
  test("a comment targeting UNUSED_SUPPRESSION reports instead of suppressing", () => {
    // 第 3 行那条指着第 4 行的 UNUSED_SUPPRESSION，正是「上面那条先留着」的写法。
    const result = applySuppressions(
      [],
      [
        {
          fileId: "a.ts",
          suppressions: [suppression("UNUSED_SUPPRESSION", 3), suppression("NOT_A_REAL_CODE", 4)],
        },
      ],
    );

    expect(codesOf(result)).toEqual(["SUPPRESSION_NOT_APPLICABLE", "UNUSED_SUPPRESSION"]);
  });

  // 首版的不动点在这里漏报：E1 被 E2 那条「本轮就要消失」的 UNUSED_SUPPRESSION 喂成 used，
  // 于是一条彻头彻尾的僵尸抑制永远不报。
  test("a live suppression next door does not launder a stale one", () => {
    const result = applySuppressions(
      [warning("DUPLICATE_ROUTE", "a.ts", 5)],
      [
        {
          fileId: "a.ts",
          suppressions: [suppression("UNUSED_SUPPRESSION", 3), suppression("DUPLICATE_ROUTE", 4)],
        },
      ],
    );

    // 第 4 行那条真压住了 warning，所以只剩第 3 行那条自指的报告。
    expect(codesOf(result)).toEqual(["SUPPRESSION_NOT_APPLICABLE"]);
  });

  test("two suppressions pointing at each other both report, in any order", () => {
    const result = applySuppressions(
      [],
      [
        {
          fileId: "a.ts",
          suppressions: [
            suppression("UNUSED_SUPPRESSION", 3),
            suppression("UNUSED_SUPPRESSION", 2),
          ],
        },
      ],
    );

    expect(codesOf(result)).toEqual(["SUPPRESSION_NOT_APPLICABLE", "SUPPRESSION_NOT_APPLICABLE"]);
  });
});
