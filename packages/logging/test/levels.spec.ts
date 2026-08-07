import { describe, expect, test } from "vitest";
import { environmentKeyForLogger, LoggerLevels, parseLogThreshold } from "@/levels";

const snapshot = {
  names: ["orders", "reforce.web", "payments.Gateway"],
  levels: { orders: "debug" as const },
  defaultLevel: "info" as const,
  layers: [".env", ".env.local"],
};

describe("logger environment keys", () => {
  // 大小写必须能还原：@reforce/config 的 buildBindingInput 有 toLowerCase，走那条路会把
  // `payments.Gateway` 和 `payments.gateway` 变成同一个键，反解不回来。
  test("maps a dotted logger name onto a single screaming key", () => {
    expect([
      environmentKeyForLogger("orders"),
      environmentKeyForLogger("reforce.web"),
      environmentKeyForLogger("payments.Gateway"),
    ]).toEqual([
      "LOGGING_LEVEL_ORDERS",
      "LOGGING_LEVEL_REFORCE_WEB",
      "LOGGING_LEVEL_PAYMENTS_GATEWAY",
    ]);
  });
});

describe("log threshold parsing", () => {
  test("accepts a level regardless of surrounding case and space", () => {
    expect(parseLogThreshold("  WARN ")).toBe("warn");
  });

  // silent 是阈值不是级别（RFC 0011 L1）：写不出 log.silent(...)，但「把这条 logger 关掉」
  // 正是配置面最常用的一档，不收它用户只能去猜一个比 fatal 还高的词。
  test("accepts silent, which turns a logger off entirely", () => {
    expect(parseLogThreshold("silent")).toBe("silent");
  });

  test("rejects a value that is neither a level nor silent", () => {
    expect(parseLogThreshold("verbose")).toBeUndefined();
  });
});

describe("logger level resolution", () => {
  test("prefers the compile-time snapshot over the default", () => {
    expect(new LoggerLevels(snapshot).levelFor("orders", {})).toBe("debug");
  });

  test("falls back to the default level for a logger the snapshot does not name", () => {
    expect(new LoggerLevels(snapshot).levelFor("reforce.web", {})).toBe("info");
  });

  // 容器编排常在启动时才给出级别，编译期看不到它。
  test("lets a runtime environment key win over the compile-time snapshot", () => {
    expect(new LoggerLevels(snapshot).levelFor("orders", { LOGGING_LEVEL_ORDERS: "error" })).toBe(
      "error",
    );
  });
});

describe("unknown logger keys", () => {
  test("reports a key that names no known logger", () => {
    const unknown = new LoggerLevels(snapshot).unknownLoggerKeys({
      LOGGING_LEVEL_ODRERS: "debug",
    });

    expect(unknown).toEqual([{ key: "LOGGING_LEVEL_ODRERS", suggestion: "LOGGING_LEVEL_ORDERS" }]);
  });

  test("stays quiet about a key that matches a known logger", () => {
    expect(new LoggerLevels(snapshot).unknownLoggerKeys({ LOGGING_LEVEL_ORDERS: "debug" })).toEqual(
      [],
    );
  });

  // warnUnmatchedKeys 那套盲展开会对 LOGGING_LEVEL_* 误报；本通道是精确查表，非日志键
  // 一概不看。
  test("ignores environment keys outside the logging namespace", () => {
    expect(new LoggerLevels(snapshot).unknownLoggerKeys({ DATABASE_URL: "x" })).toEqual([]);
  });
});
