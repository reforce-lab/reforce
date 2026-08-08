import { ApplicationStartError, InvalidGeneratedDefinitionError } from "@reforce/core";
import { describe, expect, test } from "vitest";
import type { ShutdownAckMessage } from "@/dev-ipc";
import type { CliReporterEvent, Reporter } from "@/reporter";
import { ShutdownController } from "@/shutdown-controller";

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

describe("shutdown controller", () => {
  test("queues shutdown during bootstrap and closes without entering running state", async () => {
    const reporter = new RecordingReporter();
    const controller = new ShutdownController({ command: "start", reporter });
    const applicationReady = Promise.withResolvers<{ close(): Promise<void> }>();
    let closeCount = 0;
    const startPromise = controller.start(() => applicationReady.promise);

    const finished = controller.requestShutdown();
    applicationReady.resolve({
      async close() {
        closeCount += 1;
      },
    });
    await startPromise;

    expect((await finished).exitCode).toBe(0);
    expect(controller.state).toBe("finished");
    expect(closeCount).toBe(1);
    expect(reporter.flushCount).toBe(1);
  });

  test("shares one cleanup across repeated shutdown requests", async () => {
    const reporter = new RecordingReporter();
    const controller = new ShutdownController({ command: "dev", reporter });
    let closeCount = 0;
    await controller.start(async () => ({
      async close() {
        closeCount += 1;
      },
    }));

    const first = controller.requestShutdown();
    const second = controller.requestShutdown();

    expect(first).toBe(second);
    expect((await first).exitCode).toBe(0);
    expect(closeCount).toBe(1);
  });

  test("keeps bootstrap failure primary when reporter flush also fails", async () => {
    const startupError = new Error("startup");
    const flushError = new Error("flush");
    const reporter: Reporter = {
      report() {},
      async flush() {
        throw flushError;
      },
    };
    const controller = new ShutdownController({ command: "start", reporter });

    await controller.start(async () => {
      throw startupError;
    });
    const result = await controller.finished;

    expect(result.exitCode).toBe(1);
    expect(result.primaryError).toBe(startupError);
    expect(result.errors).toEqual([startupError, flushError]);
  });

  test("preserves runtime failure details from a bootstrap cause", async () => {
    const reporter = new RecordingReporter();
    const runtimeError = new ApplicationStartError({
      cause: new InvalidGeneratedDefinitionError("runtime bootstrap failed"),
      errors: [],
    });
    const controller = new ShutdownController({ command: "start", reporter });

    await controller.start(async () => {
      throw runtimeError;
    });
    await controller.finished;

    const event = reporter.events[0];
    expect(event).toMatchObject({
      kind: "failure",
      command: "start",
      phase: "bootstrap",
      code: "APPLICATION_START_FAILED",
    });
    if (event?.kind !== "failure") {
      throw new Error("Expected a bootstrap failure event.");
    }
    expect(event.cause).toBe(runtimeError);
  });

  test("uses the CLI fallback for a filesystem error code", async () => {
    const reporter = new RecordingReporter();
    const ordinaryError = Object.assign(new Error("ordinary bootstrap failed"), {
      code: "ENOENT",
    });
    const controller = new ShutdownController({ command: "start", reporter });

    await controller.start(async () => {
      throw ordinaryError;
    });
    await controller.finished;

    const event = reporter.events[0];
    expect(event).toMatchObject({
      kind: "failure",
      command: "start",
      phase: "bootstrap",
      code: "BOOTSTRAP_FAILED",
    });
    if (event?.kind !== "failure") {
      throw new Error("Expected a bootstrap failure event.");
    }
    expect(event.cause).toBe(ordinaryError);
  });

  test("acknowledges IPC only after cleanup and flush complete", async () => {
    const reporter = new RecordingReporter();
    const controller = new ShutdownController({ command: "start", reporter });
    const closeGate = Promise.withResolvers<void>();
    const acknowledgements: ShutdownAckMessage[] = [];
    await controller.start(async () => ({ close: () => closeGate.promise }));

    const handled = controller.receiveIpcMessage(
      { type: "reforce:shutdown", requestId: "request-1" },
      (message) => acknowledgements.push(message),
    );
    await Promise.resolve();

    expect(handled).toBe(true);
    expect(acknowledgements).toEqual([]);
    closeGate.resolve();
    await controller.finished;
    expect(acknowledgements).toEqual([
      { type: "reforce:shutdown-ack", requestId: "request-1", ok: true },
    ]);
  });
});

// C3（RFC 0011，#250）：关停此前全程静默，只在失败时经 reporter 出声——「停了多久」「为什么
// 停」这两个最常问的问题一个字都没有。
describe("shutdown observability", () => {
  function capturingLogger() {
    const records: { fields: Readonly<Record<string, unknown>> | undefined; message: string }[] =
      [];
    return {
      records,
      logger: {
        info: (fields: Readonly<Record<string, unknown>> | undefined, message: string) => {
          records.push({ fields, message });
        },
      },
    };
  }

  async function stoppedController(logger?: { info: (...args: never[]) => void }) {
    const controller = new ShutdownController({
      command: "start",
      reporter: new RecordingReporter(),
    });
    await controller.start(async () => ({ close: async () => undefined }));
    if (logger !== undefined) {
      controller.setLogger(logger);
    }
    return controller;
  }

  test("announces the drain start once shutdown begins", async () => {
    const { records, logger } = capturingLogger();
    const controller = await stoppedController(logger);

    await controller.requestShutdown();

    expect(records.map((record) => record.message)).toContain("shutting down");
  });

  test("names what triggered the shutdown", async () => {
    const { records, logger } = capturingLogger();
    const controller = await stoppedController(logger);

    await controller.requestShutdown(undefined, "SIGTERM");

    expect(records[0]?.fields).toEqual({ trigger: "SIGTERM" });
  });

  test("reports how long draining took and how it ended", async () => {
    const { records, logger } = capturingLogger();
    const controller = await stoppedController(logger);

    await controller.requestShutdown();

    expect(records.find((record) => record.message === "stopped")?.fields).toEqual({
      stopMs: expect.any(Number),
      exitCode: 0,
    });
  });

  // 缺席即不打：不写日志的应用不该被迫装 @reforce/logging。
  test("stays silent when no logger was ever handed over", async () => {
    const controller = await stoppedController();

    const result = await controller.requestShutdown();

    expect(result.exitCode).toBe(0);
  });

  // 不变量 9：日志故障最吵，但关停已经没有回头路，它不该改变 exitCode。
  test("keeps the exit code when the shutdown logger itself throws", async () => {
    const controller = await stoppedController({
      info: () => {
        throw new Error("logger exploded");
      },
    });

    const result = await controller.requestShutdown();

    expect(result.exitCode).toBe(0);
  });
});
