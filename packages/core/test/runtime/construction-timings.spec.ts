import { describe, expect, test } from "vitest";
import { ConstructionTimings } from "@/runtime/construction-timings";

// 注入的时钟按调用顺序发牌，让计时用例确定：enter/exit 各读一次 now。
function clockOf(readings: readonly number[]): () => number {
  let index = 0;
  return () => readings[index++] ?? Number.NaN;
}

describe("ConstructionTimings", () => {
  test("subtracts a nested construction's elapsed time from its parent's self time", () => {
    // 外层 enter@0 → 内层 enter@10 → 内层 exit@40 → 外层 exit@100
    const timings = new ConstructionTimings(clockOf([0, 10, 40, 100]));

    const outer = timings.enter();
    const inner = timings.enter();
    timings.exit("inner", "construct", inner);
    timings.exit("outer", "construct", outer);

    expect(timings.snapshot()).toEqual([
      { id: "inner", phase: "construct", ms: 30 },
      { id: "outer", phase: "construct", ms: 70 },
    ]);
  });

  test("rounds a recorded duration to three decimal places", () => {
    const timings = new ConstructionTimings(clockOf([0, 1.23456]));

    const started = timings.enter();
    timings.exit("service", "construct", started);

    expect(timings.snapshot()[0]?.ms).toBe(1.235);
  });

  test("records a start-phase entry under its own phase", () => {
    const timings = new ConstructionTimings(clockOf([0, 12]));

    const started = timings.enter();
    timings.exit("DataSource", "start", started);

    expect(timings.snapshot()).toEqual([{ id: "DataSource", phase: "start", ms: 12 }]);
  });

  test("hands out a frozen snapshot so a consumer cannot mutate the ledger", () => {
    const timings = new ConstructionTimings(clockOf([0, 1]));
    const started = timings.enter();
    timings.exit("service", "construct", started);

    const snapshot = timings.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});
