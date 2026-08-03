import type { CliReporterEvent, Reporter } from "@/reporter";

export interface RecordingReporter {
  readonly events: CliReporterEvent[];
  readonly flushCount: number;
  readonly reporter: Reporter;
}

export function recordingReporter(onFlush?: () => void): RecordingReporter {
  const events: CliReporterEvent[] = [];
  let flushCount = 0;
  return {
    events,
    get flushCount() {
      return flushCount;
    },
    reporter: {
      report(event) {
        events.push(event);
      },
      async flush() {
        onFlush?.();
        flushCount += 1;
      },
    },
  };
}
