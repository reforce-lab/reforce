import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootstrapLogger, replayBootstrapLogs } from "@/bootstrap-registry";
import type { LogFields, Logger, LoggerFactory, LogLevel, LogRecord } from "@/contracts";
import { resetBootstrapRegistryForTest } from "@/testing";

// 进程级单例会跨用例串味，每条用例前重置。
beforeEach(() => {
  resetBootstrapRegistryForTest();
});

afterEach(() => {
  resetBootstrapRegistryForTest();
});

function recordingFactory(): {
  readonly factory: LoggerFactory;
  readonly records: LogRecord[];
} {
  const records: LogRecord[] = [];
  const factory: LoggerFactory = {
    create(name) {
      const emit = (level: LogLevel) => (fields: LogFields | undefined, message: string) => {
        records.push({ level, name, time: 0, message, fields: fields ?? {} });
      };
      const logger: Logger = {
        isEnabled: () => true,
        trace: emit("trace"),
        debug: emit("debug"),
        info: emit("info"),
        warn: emit("warn"),
        error: emit("error"),
        fatal: emit("fatal"),
      };
      return logger;
    },
  };
  return { factory, records };
}

describe("bootstrap registry", () => {
  // 配置绑定跑在一切 bean 构造之前，那一刻拿不到任何注入点——这是单例唯一说得通的场合。
  test("replays what was written before any binding existed", () => {
    bootstrapLogger("reforce.config").warn({ key: "PORT" }, "unmatched key");
    const sink = recordingFactory();

    replayBootstrapLogs(sink.factory);

    expect(sink.records).toEqual([
      expect.objectContaining({
        name: "reforce.config",
        level: "warn",
        message: "unmatched key",
      }),
    ]);
  });

  // 句柄在重放之后仍可用：调用方可以在模块作用域里取一次、一直用。
  test("keeps an early handle usable after the replay", () => {
    const logger = bootstrapLogger("reforce.config");
    const sink = recordingFactory();
    replayBootstrapLogs(sink.factory);

    logger.info(undefined, "after replay");

    expect(sink.records.map((record) => record.message)).toEqual(["after replay"]);
  });

  test("ignores a second replay so records are never duplicated", () => {
    bootstrapLogger("reforce.config").warn(undefined, "once");
    const first = recordingFactory();
    const second = recordingFactory();

    replayBootstrapLogs(first.factory);
    replayBootstrapLogs(second.factory);

    expect(first.records).toHaveLength(1);
    expect(second.records).toEqual([]);
  });

  test("stays inert when nothing was ever written", () => {
    const sink = recordingFactory();

    replayBootstrapLogs(sink.factory);

    expect(sink.records).toEqual([]);
  });
});
