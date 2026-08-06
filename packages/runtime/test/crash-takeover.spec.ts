import { describe, expect, test, vi } from "vitest";
import {
  type CrashLogTarget,
  type CrashTakeoverOptions,
  installCrashTakeover,
} from "@/crash-takeover";
import type { CliReporterEvent, Reporter } from "@/reporter";

type CrashHandler = (error: unknown, origin: NodeJS.UncaughtExceptionOrigin) => void;

// 进程替身：真 process 上装 handler 会污染 vitest worker，exit 更是直接把它杀掉。
function processDouble() {
  const handlers: CrashHandler[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  return {
    handlers,
    stderr,
    exits,
    crash(error: unknown, origin: NodeJS.UncaughtExceptionOrigin = "uncaughtException") {
      for (const handler of [...handlers]) {
        handler(error, origin);
      }
    },
    host: {
      on: (_event: "uncaughtException", handler: CrashHandler) => {
        handlers.push(handler);
      },
      off: (_event: "uncaughtException", handler: CrashHandler) => {
        handlers.splice(handlers.indexOf(handler), 1);
      },
      exit: ((code: number) => {
        exits.push(code);
        // 真 exit 永不返回；替身要让调用点继续跑完，所以这里只记账。
        return undefined as never;
      }) as (code: number) => never,
      exitCode: undefined as number | string | null | undefined,
      stderr: {
        write: (chunk: string) => stderr.push(chunk),
      },
    },
  };
}

function reporterDouble() {
  const events: CliReporterEvent[] = [];
  const reporter: Reporter = {
    report: (event) => events.push(event),
    flush: () => Promise.resolve(),
  };
  return { events, reporter };
}

function takeoverOf(overrides: Partial<CrashTakeoverOptions> = {}) {
  const host = processDouble();
  const { events, reporter } = reporterDouble();
  const takeover = installCrashTakeover({
    command: "start",
    reporter,
    process: host.host,
    ...overrides,
  });
  return { host, events, takeover };
}

function loggingDouble(overrides: Partial<CrashLogTarget> = {}) {
  const records: { fields: unknown; message: string }[] = [];
  const flushes: number[] = [];
  const logging: CrashLogTarget = {
    logger: {
      fatal: (fields, message) => records.push({ fields, message }),
    },
    factory: {
      flush: async () => {
        flushes.push(1);
        await Promise.resolve();
      },
    },
    ...overrides,
  };
  return { records, flushes, logging };
}

describe("installCrashTakeover", () => {
  test("writes the crash through the framework logger at fatal", async () => {
    const { host, takeover } = takeoverOf();
    const { records, logging } = loggingDouble();
    takeover.attach(logging);
    const error = new Error("boom");

    host.crash(error);
    await vi.waitFor(() => expect(host.exits).toEqual([1]));

    expect(records).toEqual([
      { fields: { err: error, origin: "uncaughtException" }, message: "uncaught exception" },
    ]);
  });

  test("names an unhandled rejection as such", async () => {
    const { host, takeover } = takeoverOf();
    const { records, logging } = loggingDouble();
    takeover.attach(logging);

    host.crash(new Error("boom"), "unhandledRejection");
    await vi.waitFor(() => expect(host.exits).toEqual([1]));

    expect(records[0]?.message).toBe("unhandled rejection");
  });

  // 退出码语义不变是这一项的硬约束：装了 handler 就接管了 Node 的默认行为，默认行为是退 1。
  test("sets the exit code synchronously, before any flushing is awaited", () => {
    const { host, takeover } = takeoverOf();
    takeover.attach(loggingDouble().logging);

    host.crash(new Error("boom"));

    expect(host.host.exitCode).toBe(1);
  });

  test("drains the logging sink before exiting", async () => {
    const { host, takeover } = takeoverOf();
    const { flushes, logging } = loggingDouble();
    takeover.attach(logging);

    host.crash(new Error("boom"));
    await vi.waitFor(() => expect(host.exits).toEqual([1]));

    expect(flushes).toEqual([1]);
  });

  test("exits anyway when the sink never finishes draining", async () => {
    const { host, takeover } = takeoverOf();
    takeover.attach(
      loggingDouble({ factory: { flush: () => new Promise<void>(() => undefined) } }).logging,
    );
    vi.useFakeTimers();

    host.crash(new Error("boom"));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(host.exits).toEqual([1]);
    vi.useRealTimers();
  });

  test("still exits when no logging binding was ever attached", async () => {
    const { host } = takeoverOf();

    host.crash(new Error("boom"));
    await vi.waitFor(() => expect(host.exits).toEqual([1]));

    expect(host.host.exitCode).toBe(1);
  });

  // 没有 logger 时 Node 的默认输出也没了，栈必须由兜底自己补回来。
  test("writes the whole stack to stderr when there is no logger to take it", async () => {
    const { host } = takeoverOf();
    const error = new Error("boom");

    host.crash(error);
    await vi.waitFor(() => expect(host.exits).toEqual([1]));

    expect(host.stderr.join("")).toContain(error.stack);
  });

  test("reports the crash as a failure event when there is no logger", async () => {
    const { host, events } = takeoverOf();

    host.crash(new Error("boom"));
    await vi.waitFor(() => expect(host.exits).toEqual([1]));

    expect(events).toContainEqual(
      expect.objectContaining({ kind: "failure", phase: "crash", code: "UNCAUGHT_EXCEPTION" }),
    );
  });

  // 不变量 9：日志系统自身故障必须最吵。logger 抛了不能让崩溃现场一起消失。
  test("falls back to the reporter and stderr when the crash logger itself throws", async () => {
    const { host, events, takeover } = takeoverOf();
    takeover.attach(
      loggingDouble({
        logger: {
          fatal: () => {
            throw new Error("logger exploded");
          },
        },
      }).logging,
    );
    const error = new Error("boom");

    host.crash(error);
    await vi.waitFor(() => expect(host.exits).toEqual([1]));

    expect(events.some((event) => event.kind === "failure")).toBe(true);
    expect(host.stderr.join("")).toContain(error.stack);
  });

  test("does not restart the flush when a second crash arrives mid-flight", async () => {
    const { host, takeover } = takeoverOf();
    const { flushes, logging } = loggingDouble();
    takeover.attach(logging);

    host.crash(new Error("first"));
    host.crash(new Error("second"));
    await vi.waitFor(() => expect(host.exits).toEqual([1]));

    expect(flushes).toEqual([1]);
  });

  test("announces the second crash on stderr rather than dropping it", async () => {
    const { host, takeover } = takeoverOf();
    takeover.attach(loggingDouble().logging);

    host.crash(new Error("first"));
    host.crash(new Error("second"));
    await vi.waitFor(() => expect(host.exits).toEqual([1]));

    expect(host.stderr.join("")).toContain("second");
  });

  test("ignores a binding attached after the crash already started", async () => {
    const { host, takeover } = takeoverOf();
    const { records, logging } = loggingDouble();

    host.crash(new Error("boom"));
    takeover.attach(logging);
    await vi.waitFor(() => expect(host.exits).toEqual([1]));

    expect(records).toEqual([]);
  });

  test("uninstall removes the process handler", () => {
    const { host, takeover } = takeoverOf();

    takeover.uninstall();

    expect(host.handlers).toEqual([]);
  });
});
