import { describe, expect, test } from "vitest";
import { type ChainEntryDraft, flattenChainEntries } from "@/analysis/method-interception";

// 链压平的纯函数面（ADR 0008 AM1，#202 定案 3）：并集按 beanId 去重（首现记 provenance），
// 再按 (阶段, order, beanId) 排序。v1 单标记绑定不产生重复，去重规则先钉死供前向兼容。

function entry(overrides: Partial<ChainEntryDraft> & { readonly beanId: string }): ChainEntryDraft {
  return {
    phase: "application",
    order: 0,
    markerKey: "audited",
    value: null,
    ...overrides,
  };
}

describe("flattenChainEntries", () => {
  test("sorts by phase, then order, then beanId", () => {
    const flattened = flattenChainEntries([
      entry({ beanId: "src/b.ts#B", phase: "application", order: 1 }),
      entry({ beanId: "src/a.ts#A", phase: "application", order: 1 }),
      entry({ beanId: "src/t.ts#Tx", phase: "transaction", order: 5 }),
      entry({ beanId: "src/o.ts#Trace", phase: "observability", order: 99 }),
      entry({ beanId: "src/c.ts#C", phase: "application", order: -1 }),
    ]);

    expect(flattened.map((item) => item.beanId)).toEqual([
      "src/o.ts#Trace",
      "src/t.ts#Tx",
      "src/c.ts#C",
      "src/a.ts#A",
      "src/b.ts#B",
    ]);
  });

  test("the same interceptor twice on one chain is an unreachable-state assertion, not a silent dedupe", () => {
    expect(() =>
      flattenChainEntries([
        entry({ beanId: "src/x.ts#X", markerKey: "audited", value: { label: "first" } }),
        entry({ beanId: "src/x.ts#X", markerKey: "traced", value: { label: "second" } }),
      ]),
    ).toThrow("Duplicate interceptor src/x.ts#X");
  });

  test("an empty union flattens to an empty chain", () => {
    expect(flattenChainEntries([])).toEqual([]);
  });
});
