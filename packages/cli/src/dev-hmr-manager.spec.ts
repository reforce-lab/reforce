import { describe, expect, test } from "bun:test";
import { DevEntryController } from "#internal/dev-entry";
import {
  applicationBootstrapSpecifier,
  DevHmrManager,
  type DevTimerScheduler,
  type NodeHmrRuntime,
} from "#internal/dev-hmr-manager";
import type { CliReporterEvent, Reporter } from "#internal/reporter";

function recordingScheduler(): DevTimerScheduler & {
  readonly callbacks: Array<() => void>;
  clearCount: number;
} {
  const callbacks: Array<() => void> = [];
  return {
    callbacks,
    clearCount: 0,
    setInterval(callback) {
      callbacks.push(callback);
      return callback;
    },
    clearInterval() {
      this.clearCount += 1;
    },
  };
}

class RecordingReporter implements Reporter {
  readonly events: CliReporterEvent[] = [];
  readonly #flushError: Error | undefined;
  flushCount = 0;

  constructor(flushError?: Error) {
    this.#flushError = flushError;
  }

  report(event: CliReporterEvent): void {
    this.events.push(event);
  }

  async flush(): Promise<void> {
    this.flushCount += 1;
    if (this.#flushError) {
      throw this.#flushError;
    }
  }
}

describe("development HMR manager", () => {
  test("applies an update only after the previous Context finishes closing", async () => {
    const events: string[] = [];
    const scheduler = recordingScheduler();
    let generation = 1;
    const hot: NodeHmrRuntime = {
      accept(specifier) {
        events.push(`accept:${specifier}`);
      },
      async check(autoApply) {
        events.push(`check:${autoApply}`);
        return [applicationBootstrapSpecifier];
      },
      async apply() {
        events.push("apply");
        generation = 2;
      },
    };
    const manager = new DevHmrManager({
      hot,
      scheduler,
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

    expect(events).toEqual([
      `accept:${applicationBootstrapSpecifier}`,
      "bootstrap:1",
      "check:false",
      "close:1",
      "apply",
      "bootstrap:2",
    ]);
    await manager.close();
  });

  test("notifications during an update share one operation and queue one check", async () => {
    const firstCheck = Promise.withResolvers<readonly string[]>();
    let activeChecks = 0;
    let maximumActiveChecks = 0;
    let checkCount = 0;
    const hot: NodeHmrRuntime = {
      accept() {},
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
      scheduler: recordingScheduler(),
      onFatal: () => undefined,
      bootstrap: async () => ({ close: async () => undefined }),
    });
    await manager.start();

    const first = manager.checkForUpdates();
    const second = manager.checkForUpdates();
    firstCheck.resolve([applicationBootstrapSpecifier]);

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
        accept() {},
        async check() {
          return false;
        },
        async apply() {
          applies += 1;
        },
      },
      scheduler: recordingScheduler(),
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
        accept() {},
        async check() {
          return [applicationBootstrapSpecifier];
        },
        async apply() {
          throw fatal;
        },
      },
      scheduler: recordingScheduler(),
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
    const scheduler = recordingScheduler();
    const entry = new DevEntryController({
      hot: {
        accept() {},
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
      scheduler,
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
    expect(scheduler.clearCount).toBe(1);
  });
});
