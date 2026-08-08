import { describe, expect, test } from "vitest";
import { diagnostic, hasErrorDiagnostic, orderDiagnostics } from "@/diagnostics";

// 诊断排序是确定性输出的一部分（ADR 0004）：同一份输入必须给出同一份顺序，否则 diff 会
// 无意义地翻动。severity 排在 code 之前，让同一处位置上 error 永远先于 warning 出现。

describe("orderDiagnostics", () => {
  // 这对 code 的 UTF-16 序与 severity 序**相反**：warning 的 "SUPPRESSION_NOT_APPLICABLE"
  // 排在 error 的 "TYPE_LINK_FAILED" 前面。用同向的一对（如 TYPE_LINK_FAILED / UNUSED_SUPPRESSION）
  // 断言不出任何东西——把 severity 那一行整个删掉，测试照样绿。
  test("puts an error ahead of a warning whose code sorts earlier", () => {
    const ordered = orderDiagnostics([
      diagnostic({ code: "SUPPRESSION_NOT_APPLICABLE", severity: "warning", message: "a" }),
      diagnostic({ code: "TYPE_LINK_FAILED", message: "a" }),
    ]);

    expect(ordered.map((item) => item.code)).toEqual([
      "TYPE_LINK_FAILED",
      "SUPPRESSION_NOT_APPLICABLE",
    ]);
  });

  test("falls back to the code when the severity ties", () => {
    const ordered = orderDiagnostics([
      diagnostic({ code: "UNUSED_SUPPRESSION", severity: "warning", message: "a" }),
      diagnostic({ code: "SUPPRESSION_NOT_APPLICABLE", severity: "warning", message: "a" }),
    ]);

    expect(ordered.map((item) => item.code)).toEqual([
      "SUPPRESSION_NOT_APPLICABLE",
      "UNUSED_SUPPRESSION",
    ]);
  });
});

describe("hasErrorDiagnostic", () => {
  // 闸门只看 error：warning 随 success 一起返回，图仍然是完整的。
  test("ignores a list that holds only warnings", () => {
    expect(
      hasErrorDiagnostic([
        diagnostic({ code: "UNUSED_SUPPRESSION", severity: "warning", message: "a" }),
      ]),
    ).toBe(false);
  });

  test("reports an error hiding among warnings", () => {
    expect(
      hasErrorDiagnostic([
        diagnostic({ code: "UNUSED_SUPPRESSION", severity: "warning", message: "a" }),
        diagnostic({ code: "TYPE_LINK_FAILED", message: "a" }),
      ]),
    ).toBe(true);
  });
});
