import { describe, expect, test } from "vitest";
import type { LogFields, Logger, LogLevel } from "@/contracts";
import { bindLoggerLevels } from "@/level-binding";
import { LoggerLevels } from "@/levels";

// A1（RFC 0011 L5，#249）：把编译期快照接到绑定上的那一步。它存在之前，编译器算出来的名单
// 与级别没有任何运行期读者——改级别不生效，而编译期的安静让人以为生效了。

function snapshot(overrides: Partial<ConstructorParameters<typeof LoggerLevels>[0]> = {}) {
  return new LoggerLevels({
    names: ["orders", "payments"],
    levels: { orders: "debug" },
    defaultLevel: "info",
    layers: [".env"],
    ...overrides,
  });
}

interface Recorded {
  readonly level: LogLevel;
  readonly fields: LogFields | undefined;
  readonly message: string;
}

function recordingLogger(): { readonly logger: Logger; readonly records: Recorded[] } {
  const records: Recorded[] = [];
  const emit = (level: LogLevel) => (fields: LogFields | undefined, message: string) => {
    records.push({ level, fields, message });
  };
  return {
    records,
    logger: {
      isEnabled: () => true,
      trace: emit("trace"),
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      fatal: emit("fatal"),
    },
  };
}

describe("binding the compile-time level snapshot", () => {
  test("resolves the level a compile-time layer set for a named logger", () => {
    const resolve = bindLoggerLevels({ levels: snapshot(), environment: {} });

    expect(resolve("orders")).toBe("debug");
  });

  // 绑定自己的缺省（PinoSettings.level / defaultLevel）是用户显式写下的，快照没有逐个指定
  // 这条 logger 时不该把它顶掉——所以这里是 undefined，不是快照的 defaultLevel。
  test("says nothing about a logger the snapshot does not name", () => {
    const resolve = bindLoggerLevels({ levels: snapshot(), environment: {} });

    expect(resolve("payments")).toBeUndefined();
  });

  test("lets a runtime environment key win over the compile-time layer", () => {
    const resolve = bindLoggerLevels({
      levels: snapshot(),
      environment: { LOGGING_LEVEL_ORDERS: "error" },
    });

    expect(resolve("orders")).toBe("error");
  });

  test("resolves nothing at all when no snapshot is bound", () => {
    expect(bindLoggerLevels()("orders")).toBeUndefined();
  });
});

describe("startup warnings about the half the compiler cannot see", () => {
  test("warns about a process environment key naming no logger", () => {
    const { logger, records } = recordingLogger();

    bindLoggerLevels({
      levels: snapshot(),
      environment: { LOGGING_LEVEL_ODRERS: "debug" },
      report: logger,
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe("warn");
  });

  test("suggests the nearest known key for a misspelled one", () => {
    const { logger, records } = recordingLogger();

    bindLoggerLevels({
      levels: snapshot(),
      environment: { LOGGING_LEVEL_ODRERS: "debug" },
      report: logger,
    });

    expect(records[0]?.message).toContain("Did you mean LOGGING_LEVEL_ORDERS?");
  });

  // REFORCE_PROFILE 是运行期进程变量：`reforce build` 与 `reforce start` 的取值可能不同，
  // 那一层的 logger 名从来没被编译期看过。不假装校验过，如实说一句。
  test("warns when REFORCE_PROFILE selects a layer the compiler never read", () => {
    const { logger, records } = recordingLogger();

    bindLoggerLevels({
      levels: snapshot(),
      environment: { REFORCE_PROFILE: "production" },
      report: logger,
    });

    expect(records[0]?.message).toContain(".env.production");
  });

  test("stays quiet when the selected profile layer was compiled in", () => {
    const { logger, records } = recordingLogger();

    bindLoggerLevels({
      levels: snapshot({ layers: [".env", ".env.production"] }),
      environment: { REFORCE_PROFILE: "production" },
      report: logger,
    });

    expect(records).toEqual([]);
  });

  test("stays quiet when every key names a known logger", () => {
    const { logger, records } = recordingLogger();

    bindLoggerLevels({
      levels: snapshot(),
      environment: { LOGGING_LEVEL_ORDERS: "debug", DATABASE_URL: "x" },
      report: logger,
    });

    expect(records).toEqual([]);
  });
});
