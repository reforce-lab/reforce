import { describe, expect, test } from "bun:test";
import {
  chainFieldNameFor,
  compareChainEntries,
  interceptPhaseOrder,
  interceptPhaseRank,
} from "@/analysis/interception-model";

// 链序是织入表与 $Woven 的确定性来源（ADR 0008 AM1，#202 定案 1）：阶段闭集数组序即
// 外→内链序，三级决胜 (阶段, order, beanId) 与 web 完全同形。

describe("intercept phase order", () => {
  test("ranks phases by the closed five-phase array order", () => {
    expect(interceptPhaseOrder).toEqual([
      "observability",
      "admission",
      "cache",
      "transaction",
      "application",
    ]);
    expect(interceptPhaseOrder.map(interceptPhaseRank)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("compareChainEntries", () => {
  test("phase rank wins over order and beanId", () => {
    const inner = { phase: "application", order: -100, beanId: "a" } as const;
    const outer = { phase: "observability", order: 100, beanId: "z" } as const;

    expect(compareChainEntries(outer, inner)).toBeLessThan(0);
    expect(compareChainEntries(inner, outer)).toBeGreaterThan(0);
  });

  test("order breaks ties within a phase", () => {
    const first = { phase: "transaction", order: -1, beanId: "z" } as const;
    const second = { phase: "transaction", order: 3, beanId: "a" } as const;

    expect(compareChainEntries(first, second)).toBeLessThan(0);
  });

  test("beanId breaks ties as the final key", () => {
    const first = { phase: "cache", order: 0, beanId: "src/a.ts#A" } as const;
    const second = { phase: "cache", order: 0, beanId: "src/b.ts#B" } as const;

    expect(compareChainEntries(first, second)).toBeLessThan(0);
    expect(compareChainEntries(first, first)).toBe(0);
  });
});

describe("chainFieldNameFor", () => {
  test("uses the default name when the class does not declare it", () => {
    expect(chainFieldNameFor(new Set(["save", "repository"]))).toBe("interceptorChains");
  });

  test("escapes user member collisions deterministically", () => {
    expect(chainFieldNameFor(new Set(["interceptorChains"]))).toBe("interceptorChains$");
    expect(chainFieldNameFor(new Set(["interceptorChains", "interceptorChains$"]))).toBe(
      "interceptorChains$$",
    );
  });
});
