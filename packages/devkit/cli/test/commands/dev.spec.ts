import type { CliReporterEvent, Reporter } from "@reforce/runtime/reporter";
import { describe, expect, test } from "vitest";
import { DevCommandController, shutdownAfterPrimaryFailure } from "@/commands/dev";
import { DevChildSupervisor } from "@/dev/child-supervisor";
import { DevWatchCoordinator } from "@/dev/watch-coordinator";

class RecordingReporter implements Reporter {
  readonly events: CliReporterEvent[] = [];
  flushCount = 0;

  report(event: CliReporterEvent): void {
    this.events.push(event);
  }

  async flush(): Promise<void> {
    this.flushCount += 1;
  }
}

class FlushFailureReporter extends RecordingReporter {
  override async flush(): Promise<void> {
    throw new Error("report output unavailable");
  }
}

function controllerWithFailingWatch(reporter: Reporter): DevCommandController {
  const supervisor = new DevChildSupervisor({
    spawn: async () => {
      throw new Error("spawn must not run during shutdown-only scenarios");
    },
  });
  return new DevCommandController({
    watch: {
      async close() {
        throw new Error("watcher refused to close");
      },
    },
    watchCoordinator: new DevWatchCoordinator({ reporter, supervisor }),
    supervisor,
    reporter,
  });
}

describe("shutdown after a primary dev failure", () => {
  // 回归：controller.shutdown() 的失败曾被空 catch 吞掉，SHUTDOWN_FAILED 汇报链路收不到它（#314）。
  test("a controller shutdown failure joins the shutdown failure ledger", async () => {
    const reporter = new RecordingReporter();
    const controller = controllerWithFailingWatch(reporter);
    const shutdownFailures: unknown[] = [];

    await shutdownAfterPrimaryFailure({ controller, reporter, shutdownFailures });

    expect(shutdownFailures).toHaveLength(1);
    expect(shutdownFailures[0]).toBeInstanceOf(AggregateError);
  });

  test("a clean controller shutdown leaves the ledger empty", async () => {
    const reporter = new RecordingReporter();
    const supervisor = new DevChildSupervisor({
      spawn: async () => {
        throw new Error("spawn must not run during shutdown-only scenarios");
      },
    });
    const controller = new DevCommandController({
      watch: { close: async () => undefined },
      watchCoordinator: new DevWatchCoordinator({ reporter, supervisor }),
      supervisor,
      reporter,
    });
    const shutdownFailures: unknown[] = [];

    await shutdownAfterPrimaryFailure({ controller, reporter, shutdownFailures });

    expect(shutdownFailures).toEqual([]);
  });

  test("without a controller the pending failure report is still flushed", async () => {
    const reporter = new RecordingReporter();
    const shutdownFailures: unknown[] = [];

    await shutdownAfterPrimaryFailure({ controller: undefined, reporter, shutdownFailures });

    expect(reporter.flushCount).toBe(1);
    expect(shutdownFailures).toEqual([]);
  });

  test("without a controller a flush failure joins the shutdown failure ledger", async () => {
    const reporter = new FlushFailureReporter();
    const shutdownFailures: unknown[] = [];

    await shutdownAfterPrimaryFailure({ controller: undefined, reporter, shutdownFailures });

    expect(shutdownFailures).toHaveLength(1);
    expect(shutdownFailures[0]).toMatchObject({ message: "report output unavailable" });
  });
});
