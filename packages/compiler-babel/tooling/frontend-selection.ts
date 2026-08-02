export type FrontendId = "babel" | "yuku";

export interface FrontendSummary {
  readonly frontend: FrontendId;
  readonly coldP95Nanoseconds: number;
  readonly incrementalP95Nanoseconds: number;
  readonly peakRssBytes: number;
}

function withinFivePercent(left: number, right: number): boolean {
  return Math.max(left, right) <= Math.min(left, right) * 1.05;
}

export function selectDefaultFrontend(babel: FrontendSummary, yuku: FrontendSummary): FrontendId {
  if (!withinFivePercent(babel.incrementalP95Nanoseconds, yuku.incrementalP95Nanoseconds)) {
    return babel.incrementalP95Nanoseconds < yuku.incrementalP95Nanoseconds ? "babel" : "yuku";
  }
  if (!withinFivePercent(babel.peakRssBytes, yuku.peakRssBytes)) {
    return babel.peakRssBytes < yuku.peakRssBytes ? "babel" : "yuku";
  }
  if (!withinFivePercent(babel.coldP95Nanoseconds, yuku.coldP95Nanoseconds)) {
    return babel.coldP95Nanoseconds < yuku.coldP95Nanoseconds ? "babel" : "yuku";
  }
  return "babel";
}

export function aggregateWorstCase(
  frontend: FrontendId,
  measurements: readonly FrontendSummary[],
): FrontendSummary {
  return {
    frontend,
    coldP95Nanoseconds: Math.max(
      ...measurements.map((measurement) => measurement.coldP95Nanoseconds),
    ),
    incrementalP95Nanoseconds: Math.max(
      ...measurements.map((measurement) => measurement.incrementalP95Nanoseconds),
    ),
    peakRssBytes: Math.max(...measurements.map((measurement) => measurement.peakRssBytes)),
  };
}
