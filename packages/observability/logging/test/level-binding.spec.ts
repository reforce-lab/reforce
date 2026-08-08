import { describe, expect, test } from "vitest";
import type { LogFields, Logger, LogLevel } from "@/contracts";
import { bindLoggerLevels } from "@/level-binding";
import { LoggerLevels } from "@/levels";

// 显式级别配置接到绑定上的那一步（RFC 0011 L5 勘误，#242）：级别的唯一真相是
// LoggingSettings.levels，封闭名单只服务启动期的 did-you-mean。

const names = new LoggerLevels({ names: ["orders", "payments"] });

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

describe("binding explicit level settings", () => {
  test("resolves the level settings.levels sets for a named logger", () => {
    const resolve = bindLoggerLevels({ settings: { levels: { orders: "debug" } }, levels: names });

    expect(resolve("orders")).toBe("debug");
  });

  // 绑定自己的缺省（LoggingSettings.defaultLevel / options.defaultLevel）是用户显式写下的，
  // settings.levels 没有逐个指定这条 logger 时不该把它顶掉——所以这里是 undefined。
  test("says nothing about a logger the settings do not name", () => {
    const resolve = bindLoggerLevels({ settings: { levels: { orders: "debug" } }, levels: names });

    expect(resolve("payments")).toBeUndefined();
  });

  test("resolves nothing at all when neither settings nor a name list exist", () => {
    const resolve = bindLoggerLevels({});

    expect(resolve("orders")).toBeUndefined();
  });
});

describe("reporting misspelt logger names at startup", () => {
  test("warns with a did-you-mean when a configured name misses the closed list", () => {
    const { logger, records } = recordingLogger();

    bindLoggerLevels({ settings: { levels: { odrers: "debug" } }, levels: names, report: logger });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "warn",
      fields: { key: "odrers", suggestion: "orders" },
    });
  });

  test("stays quiet when every configured name is on the closed list", () => {
    const { logger, records } = recordingLogger();

    bindLoggerLevels({
      settings: { levels: { orders: "debug", payments: "silent" } },
      levels: names,
      report: logger,
    });

    expect(records).toEqual([]);
  });

  // 名单 bean 缺席时没有可比对的事实：不 warn，而不是把每个键都当成拼错。
  test("does not guess without the compiler's closed name list", () => {
    const { logger, records } = recordingLogger();

    bindLoggerLevels({ settings: { levels: { odrers: "debug" } }, report: logger });

    expect(records).toEqual([]);
  });
});
