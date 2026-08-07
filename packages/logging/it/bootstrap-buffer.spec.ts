import { describe, expect, test } from "vitest";
import { createBootstrapLogBuffer } from "@/bootstrap-buffer";
import type { LogFields, Logger, LogLevel } from "@/contracts";

interface Captured {
  readonly name: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

function recordingResolver(): {
  readonly resolve: (name: string) => Logger;
  readonly captured: Captured[];
} {
  const captured: Captured[] = [];
  const resolve = (name: string): Logger => {
    const emit = (level: LogLevel) => (fields: LogFields | undefined, message: string) => {
      captured.push({ name, level, message, fields: fields ?? {} });
    };
    return {
      isEnabled: () => true,
      trace: emit("trace"),
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      fatal: emit("fatal"),
    };
  };
  return { resolve, captured };
}

describe("bootstrap log buffer", () => {
  test("replays what was logged before the binding existed", () => {
    const buffer = createBootstrapLogBuffer();
    buffer.logger("orders").info({ step: 1 }, "before binding");
    const sink = recordingResolver();

    buffer.replayInto(sink.resolve);

    expect(sink.captured).toEqual([
      expect.objectContaining({ name: "orders", level: "info", message: "before binding" }),
    ]);
  });

  // 重放用原始时间戳，否则引导期的时序会被压平成同一瞬间。
  test("replays with the timestamp each record was taken at", () => {
    let clock = 1_000;
    const buffer = createBootstrapLogBuffer({ now: () => (clock += 10) });
    buffer.logger("a").info(undefined, "first");
    buffer.logger("b").info(undefined, "second");
    const sink = recordingResolver();

    buffer.replayInto(sink.resolve);

    expect(sink.captured.map((item) => item.fields.bootstrapTime)).toEqual([1_010, 1_020]);
  });

  // 丢最旧的：引导期最后几条恰恰是失败现场。
  test("drops the oldest records when the buffer overflows and says how many", () => {
    const buffer = createBootstrapLogBuffer({ capacity: 2 });
    for (const message of ["one", "two", "three"]) {
      buffer.logger("orders").info(undefined, message);
    }
    const sink = recordingResolver();

    buffer.replayInto(sink.resolve);

    expect(buffer.droppedCount()).toBe(1);
    expect(sink.captured.map((item) => item.message)).toEqual([
      "Bootstrap log buffer overflowed; the oldest records were dropped.",
      "two",
      "three",
    ]);
  });

  // 绑定构造失败时缓冲是唯一的现场，绝不静默丢弃。
  // short 单行文本（RFC 0011 L7）：这条路只在绑定构造失败/退出兜底时走，读者是正在看启动
  // 失败输出的人——一行 JSON 不合格，err 只留 name: message。
  test("drains to stderr as short single-line text when the binding never arrives", () => {
    const buffer = createBootstrapLogBuffer();
    buffer.logger("orders").error({ err: new Error("boom") }, "binding failed");
    const lines: string[] = [];

    buffer.drainToStderr((line) => lines.push(line));

    expect(lines).toEqual(["error orders binding failed err=Error: boom"]);
  });

  // isEnabled 同样转发：退场后继续按缓冲阈值答，调用方会在真 logger 已关掉的级别上白构造
  // 昂贵字段（不变量 8 的另一半）。
  test("answers isEnabled from the live logger once retired", () => {
    const buffer = createBootstrapLogBuffer({ threshold: "trace" });
    const retained = buffer.logger("orders");
    buffer.replayInto(() => ({
      isEnabled: (level) => level === "error" || level === "fatal",
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
      fatal() {},
    }));

    expect(retained.isEnabled("debug")).toBe(false);
    expect(retained.isEnabled("error")).toBe(true);
  });

  // 退场后仍持有旧句柄的调用方不能继续攒：那些记录再也不会被重放。
  test("forwards to the live logger once the bootstrap logger has retired", () => {
    const buffer = createBootstrapLogBuffer();
    const retained = buffer.logger("orders");
    const sink = recordingResolver();
    buffer.replayInto(sink.resolve);

    retained.info(undefined, "after retirement");

    expect(sink.captured.map((item) => item.message)).toEqual(["after retirement"]);
  });

  test("keeps a below-threshold record out of the buffer entirely", () => {
    const buffer = createBootstrapLogBuffer({ threshold: "warn" });
    buffer.logger("orders").debug(undefined, "noise");
    const sink = recordingResolver();

    buffer.replayInto(sink.resolve);

    expect(sink.captured).toEqual([]);
  });
});
