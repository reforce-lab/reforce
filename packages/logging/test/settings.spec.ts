import { describe, expect, test } from "vitest";
import type { LogFields, Logger, LogLevel } from "@/contracts";
import { reportUnknownLoggerLevels, unknownLoggerLevelKeys } from "@/settings";

// 显式级别配置的第二道防线（RFC 0011 L5 勘误）：级别词拼错由 tsc 拦（封闭 union），这里
// 验证的是 logger 名拼错的那一半——对编译器合成的封闭名单精确比对，每次启动必报。

const names = ["OrderService", "PaymentGateway", "reforce.web"];

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

describe("unknown logger level keys", () => {
  test("reports a key that names no known logger, with the nearest name attached", () => {
    expect(unknownLoggerLevelKeys({ OrdrService: "debug" }, names)).toEqual([
      { key: "OrdrService", suggestion: "OrderService" },
    ]);
  });

  test("reports a key with no nearby name without inventing a suggestion", () => {
    expect(unknownLoggerLevelKeys({ CompletelyElsewhere: "warn" }, names)).toEqual([
      { key: "CompletelyElsewhere" },
    ]);
  });

  test("stays quiet about keys that match the closed name list", () => {
    expect(unknownLoggerLevelKeys({ OrderService: "debug", "reforce.web": "warn" }, names)).toEqual(
      [],
    );
  });

  test("treats absent levels as nothing to check", () => {
    expect(unknownLoggerLevelKeys(undefined, names)).toEqual([]);
  });
});

describe("reporting unknown logger levels", () => {
  test("warns once per misspelt key with a did-you-mean", () => {
    const { logger, records } = recordingLogger();

    reportUnknownLoggerLevels({ OrdrService: "debug" }, names, logger);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "warn",
      fields: { key: "OrdrService", suggestion: "OrderService" },
    });
    expect(records[0]?.message).toContain('Did you mean "OrderService"?');
  });

  test("does not warn when every key names a known logger", () => {
    const { logger, records } = recordingLogger();

    reportUnknownLoggerLevels({ OrderService: "silent" }, names, logger);

    expect(records).toEqual([]);
  });
});
