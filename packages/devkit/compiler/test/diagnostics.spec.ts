import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { stableStructuralKey } from "@/determinism";
import { diagnostic, hasErrorDiagnostic, orderDiagnostics } from "@/diagnostics";
import type { CanonicalFileId, SourceSpan } from "@/parser/source-location";

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

// ———— 去重键的行为（#367）————
//
// orderDiagnostics 与 normalizeRelated 都用 stableStructuralKey 去重，而它走 Object.keys——
// **会收录值为 undefined 的键**。`diagnostic()` 今天总是写全 9 个键（缺省一律显式 undefined），
// 所以经它构造的诊断形状恒定，键才稳定。
//
// 开 exactOptionalPropertyTypes 会强制 `diagnostic()` 改成条件展开，键集从恒定 9 个变成按内容
// 变化。下面这批断言钉的是「同内容 ⇒ 同键、不同内容 ⇒ 不同键」这条性质本身，与键集大小无关，
// 因此必须在改造前后都绿——那是「行为不变」的唯一判据。

function span(file: string, offset: number): SourceSpan {
  return {
    fileId: file as CanonicalFileId, // 测试直接给出 source discovery 才有权造的不透明身份。
    start: { offset, line: 0, character: offset },
    end: { offset: offset + 1, line: 0, character: offset + 1 },
  };
}

describe("诊断的去重键", () => {
  test("同一条诊断构造两次落成同一个键", () => {
    const build = () =>
      diagnostic({
        code: "TYPE_LINK_FAILED",
        message: "a",
        sourceSpan: span("src/a.ts", 1),
        help: "h",
      });

    expect(stableStructuralKey(build())).toBe(stableStructuralKey(build()));
  });

  test("orderDiagnostics 去掉逐字段相同的重复项", () => {
    const build = () => diagnostic({ code: "TYPE_LINK_FAILED", message: "a" });

    const ordered = orderDiagnostics([build(), build(), build()]);

    expect(ordered).toHaveLength(1);
  });

  test.each([
    ["message", { message: "b" }],
    ["help", { help: "other" }],
    ["severity", { severity: "warning" as const }],
  ])("%s 不同的两条诊断不会被去重掉一条", (_field, override) => {
    const base = { code: "TYPE_LINK_FAILED", message: "a", help: "h" } as const;

    const ordered = orderDiagnostics([diagnostic(base), diagnostic({ ...base, ...override })]);

    expect(ordered).toHaveLength(2);
  });

  test("位置不同的同文诊断各自保留", () => {
    const at = (offset: number) =>
      diagnostic({ code: "TYPE_LINK_FAILED", message: "a", sourceSpan: span("src/a.ts", offset) });

    const ordered = orderDiagnostics([at(1), at(2)]);

    expect(ordered).toHaveLength(2);
  });

  test("缺省 help 与显式 help: undefined 是同一条诊断", () => {
    // 这条正是 eOPT 改造的靶心：改造后 `help: undefined` 不会再写进对象，键集因此变化。
    // 两侧仍必须落成同一个键，否则同一条诊断会在输出里出现两遍。
    const omitted = diagnostic({ code: "TYPE_LINK_FAILED", message: "a" });
    const explicit = diagnostic({ code: "TYPE_LINK_FAILED", message: "a", help: undefined });

    expect(stableStructuralKey(omitted)).toBe(stableStructuralKey(explicit));
  });
});

describe("related 的归一", () => {
  test("逐字段相同的 related 只留一条", () => {
    const item = { message: "note", sourceSpan: span("src/a.ts", 1) };

    const built = diagnostic({
      code: "TYPE_LINK_FAILED",
      message: "a",
      related: [item, { ...item }],
    });

    expect(built.related).toHaveLength(2 - 1);
  });

  test("related 的顺序与书写顺序无关", () => {
    const first = { message: "a", sourceSpan: span("src/a.ts", 1) };
    const second = { message: "b", sourceSpan: span("src/a.ts", 2) };

    const forward = diagnostic({
      code: "TYPE_LINK_FAILED",
      message: "m",
      related: [first, second],
    });
    const backward = diagnostic({
      code: "TYPE_LINK_FAILED",
      message: "m",
      related: [second, first],
    });

    expect(forward.related).toEqual(backward.related);
  });

  test("无位置的 related 排在有位置的后面", () => {
    const built = diagnostic({
      code: "TYPE_LINK_FAILED",
      message: "m",
      related: [{ message: "no span" }, { message: "with span", sourceSpan: span("src/a.ts", 1) }],
    });

    expect(built.related.map((item) => item.message)).toEqual(["with span", "no span"]);
  });
});

describe("stableStructuralKey 的不变量", () => {
  test("键的相等性与对象的书写顺序无关", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 6 }), (record) => {
        const shuffled = Object.fromEntries(Object.entries(record).toReversed());

        return stableStructuralKey(record) === stableStructuralKey(shuffled);
      }),
    );
  });

  test("内容不同的两个对象拿到不同的键", () => {
    expect(stableStructuralKey({ a: 1 })).not.toBe(stableStructuralKey({ a: 2 }));
  });
});
