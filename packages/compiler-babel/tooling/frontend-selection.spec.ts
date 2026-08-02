import { expect, test } from "bun:test";
import {
  aggregateWorstCase,
  type FrontendId,
  type FrontendSummary,
  selectDefaultFrontend,
} from "#tooling/frontend-selection";

function summary(
  frontend: FrontendId,
  incrementalP95Nanoseconds: number,
  peakRssBytes: number,
  coldP95Nanoseconds: number,
): FrontendSummary {
  return { frontend, incrementalP95Nanoseconds, peakRssBytes, coldP95Nanoseconds };
}

test("incremental P95 decides when the measurements differ by more than five percent", () => {
  const babel = summary("babel", 106, 90, 80);
  const yuku = summary("yuku", 100, 110, 120);

  const selected = selectDefaultFrontend(babel, yuku);

  expect(selected).toBe("yuku");
});

test("peak RSS decides when incremental P95 is within five percent", () => {
  const babel = summary("babel", 105, 106, 80);
  const yuku = summary("yuku", 100, 100, 120);

  const selected = selectDefaultFrontend(babel, yuku);

  expect(selected).toBe("yuku");
});

test("cold P95 decides when incremental P95 and peak RSS are within five percent", () => {
  const babel = summary("babel", 105, 105, 106);
  const yuku = summary("yuku", 100, 100, 100);

  const selected = selectDefaultFrontend(babel, yuku);

  expect(selected).toBe("yuku");
});

test("Babel wins when every measurement is within five percent", () => {
  const babel = summary("babel", 105, 105, 105);
  const yuku = summary("yuku", 100, 100, 100);

  const selected = selectDefaultFrontend(babel, yuku);

  expect(selected).toBe("babel");
});

test("cross-platform selection uses each frontend's worst platform measurement", () => {
  const measurements = [
    summary("babel", 20, 50, 30),
    summary("babel", 40, 35, 60),
    summary("babel", 30, 70, 45),
  ];

  const aggregated = aggregateWorstCase("babel", measurements);

  expect(aggregated).toEqual(summary("babel", 40, 70, 60));
});
