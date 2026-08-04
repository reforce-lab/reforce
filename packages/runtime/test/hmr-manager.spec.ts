import { describe, expect, test } from "bun:test";
import { DevEntryController } from "@/dev-entry";
import { DevHmrManager, type RspackHmrRuntime } from "@/hmr-manager";
import type { CliReporterEvent, Reporter } from "@/reporter";

// Stands in for whatever module id rspack reports as outdated; the manager only checks emptiness.
const outdatedModuleId = "./.reforce/generated/bootstrap.ts";

class RecordingReporter implements Reporter {
  readonly events: CliReporterEvent[] = [];
  private readonly flushError: Error | undefined;
  flushCount = 0;

  constructor(flushError?: Error) {
    this.flushError = flushError;
  }

  report(event: CliReporterEvent): void {
    this.events.push(event);
  }

  async flush(): Promise<void> {
    this.flushCount += 1;
    if (this.flushError) {
      throw this.flushError;
    }
  }
}

describe("development HMR manager", () => {
  test("applies an update only after the previous Context finishes closing", async () => {
    const events: string[] = [];
    let generation = 1;
    const hot: RspackHmrRuntime = {
      async check(autoApply) {
        events.push(`check:${autoApply}`);
        return [outdatedModuleId];
      },
      async apply() {
        events.push("apply");
        generation = 2;
      },
    };
    const manager = new DevHmrManager({
      hot,
      onFatal: () => undefined,
      bootstrap: async () => {
        const currentGeneration = generation;
        events.push(`bootstrap:${currentGeneration}`);
        return {
          async close() {
            events.push(`close:${currentGeneration}`);
          },
        };
      },
    });
    await manager.start();

    await manager.checkForUpdates();

    expect(events).toEqual(["bootstrap:1", "check:false", "close:1", "apply", "bootstrap:2"]);
    await manager.close();
  });

  test("notifications during an update share one operation and queue one check", async () => {
    const firstCheck = Promise.withResolvers<readonly string[]>();
    let activeChecks = 0;
    let maximumActiveChecks = 0;
    let checkCount = 0;
    const hot: RspackHmrRuntime = {
      async check() {
        checkCount += 1;
        activeChecks += 1;
        maximumActiveChecks = Math.max(maximumActiveChecks, activeChecks);
        const result = checkCount === 1 ? await firstCheck.promise : false;
        activeChecks -= 1;
        return result;
      },
      async apply() {},
    };
    const manager = new DevHmrManager({
      hot,
      onFatal: () => undefined,
      bootstrap: async () => ({ close: async () => undefined }),
    });
    await manager.start();

    const first = manager.checkForUpdates();
    const second = manager.checkForUpdates();
    firstCheck.resolve([outdatedModuleId]);

    expect(second).toBe(first);
    await first;
    expect(checkCount).toBe(2);
    expect(maximumActiveChecks).toBe(1);
    await manager.close();
  });

  test("a check without an update preserves the current Context", async () => {
    let bootstraps = 0;
    let closes = 0;
    let applies = 0;
    const manager = new DevHmrManager({
      hot: {
        async check() {
          return false;
        },
        async apply() {
          applies += 1;
        },
      },
      onFatal: () => undefined,
      bootstrap: async () => {
        bootstraps += 1;
        return {
          async close() {
            closes += 1;
          },
        };
      },
    });
    await manager.start();

    await manager.checkForUpdates();

    expect(bootstraps).toBe(1);
    expect(closes).toBe(0);
    expect(applies).toBe(0);
    await manager.close();
  });

  test("an apply failure does not close the previous Context twice", async () => {
    const fatal = new Error("apply failed");
    const fatalErrors: unknown[] = [];
    let closes = 0;
    const manager = new DevHmrManager({
      hot: {
        async check() {
          return [outdatedModuleId];
        },
        async apply() {
          throw fatal;
        },
      },
      onFatal: (error) => fatalErrors.push(error),
      bootstrap: async () => ({
        async close() {
          closes += 1;
        },
      }),
    });
    await manager.start();

    await expect(manager.checkForUpdates()).rejects.toBe(fatal);
    await manager.close();

    expect(closes).toBe(1);
    expect(fatalErrors).toEqual([fatal]);
  });

  test("a fatal check uses one shutdown and preserves cleanup and flush errors", async () => {
    const fatal = new Error("check failed");
    const cleanup = new Error("cleanup failed");
    const flush = new Error("flush failed");
    const reporter = new RecordingReporter(flush);
    const entry = new DevEntryController({
      hot: {
        async check() {
          throw fatal;
        },
        async apply() {},
      },
      bootstrap: async () => ({
        async close() {
          throw cleanup;
        },
      }),
      reporter,
      installProcessHandlers: false,
    });
    await entry.start();

    await Promise.allSettled([entry.checkForUpdates(), entry.checkForUpdates()]);
    const result = await entry.finished;

    expect(result.exitCode).toBe(1);
    expect(result.primaryError).toBe(fatal);
    expect(result.errors).toEqual([fatal, cleanup, flush]);
    expect(reporter.events).toHaveLength(2);
    expect(reporter.flushCount).toBe(1);
  });
});
