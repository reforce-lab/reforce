import { Writable } from "node:stream";
import {
  type LogFieldSource,
  LoggerLevels,
  type LogLevel,
  type LogRecord,
  type LogThreshold,
} from "@reforce/logging";
import { loggerConformanceCases } from "@reforce/logging/conformance";
import { describe, expect, test } from "vitest";
import { PinoLoggerFactory } from "@/factory";

// 一致性套件跑在真实 pino 上（IT 而不是单测）：它断言的是「门面契约在这个绑定上成立」，
// 只有真的走完 pino 的序列化与写出才算数。记录从写出的 NDJSON 解析回来，断言的因此是
// 线上真的写了什么，而不是内部对象。

interface Captured {
  readonly lines: string[];
  readonly stream: Writable;
}

function capturingStream(): Captured {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim().length > 0) {
          lines.push(line);
        }
      }
      callback();
    },
  });
  return { lines, stream };
}

// pino 的级别名与门面完全一致，数值刻度也一致——这一层是恒等的，没有翻译。
// 数值与名字两种形态都走同一张封闭表：写出的级别一旦落在表外，是「刻度漂了」的信号，
// 必须当场失败，而不是把一个未经校验的字符串当成 LogLevel 传下去。
const levelByWireValue = new Map<unknown, LogLevel>([
  [10, "trace"],
  [20, "debug"],
  [30, "info"],
  [40, "warn"],
  [50, "error"],
  [60, "fatal"],
  ["trace", "trace"],
  ["debug", "debug"],
  ["info", "info"],
  ["warn", "warn"],
  ["error", "error"],
  ["fatal", "fatal"],
]);

function pinoLevelName(value: unknown): LogLevel {
  const name = levelByWireValue.get(value);
  if (name === undefined) {
    throw new Error(`pino wrote an unrecognised level: ${String(value)}`);
  }
  return name;
}

function parseRecord(line: string): LogRecord {
  const { level, name, time, msg, ...fields } = JSON.parse(line);
  return { level: pinoLevelName(level), name, time, message: msg, fields };
}

// 级别快照（RFC 0011 L5）：这些用例验的是门面契约与 pino 的原生选项，逐 logger 调级另有专门
// 用例，所以缺省给一份空名单——每条 logger 都落回 settings.level，正是它们要的基线。
function levelsOf(names: readonly string[] = []): LoggerLevels {
  return new LoggerLevels({ names, levels: {}, defaultLevel: "info", layers: [] });
}

function bound(input: {
  readonly defaultLevel: LogThreshold;
  readonly fieldSources: readonly LogFieldSource[];
}) {
  const captured = capturingStream();
  const factory = new PinoLoggerFactory(
    {},
    input.fieldSources,
    [],
    [{ destination: () => captured.stream }],
    levelsOf(),
    { defaultLevel: input.defaultLevel },
  );
  return { factory, records: () => captured.lines.map(parseRecord) };
}

describe("pino binding conformance", () => {
  for (const item of loggerConformanceCases({ name: "pino", create: bound })) {
    test(item.name, () => {
      item.run();
    });
  }
});

describe("pino binding specifics", () => {
  // 级别刻度一致是「没有翻译层」的前提，值一旦漂移，逐 logger 调级会静默错档。
  test("writes the same numeric level scale the facade declares", () => {
    const captured = capturingStream();
    const factory = new PinoLoggerFactory(
      {},
      [],
      [],
      [{ destination: () => captured.stream }],
      levelsOf(),
      { defaultLevel: "trace" },
    );

    factory.create("orders").warn(undefined, "probe");

    expect(JSON.parse(captured.lines[0] ?? "{}").level).toBe(40);
  });

  test("carries the logger name into every record", () => {
    const captured = capturingStream();
    const factory = new PinoLoggerFactory(
      {},
      [],
      [],
      [{ destination: () => captured.stream }],
      levelsOf(),
      {},
    );

    factory.create("payments").info(undefined, "probe");

    expect(JSON.parse(captured.lines[0] ?? "{}").name).toBe("payments");
  });

  // configurer 依次改写、后一个拿到前一个的产物，顺序敏感度因此可见。
  test("threads each configurer's output into the next", () => {
    const captured = capturingStream();
    const factory = new PinoLoggerFactory(
      {},
      [],
      [
        { configure: (options) => ({ ...options, base: { stage: "first" } }) },
        {
          configure: (options) => ({
            ...options,
            base: { ...options.base, stage: "second", kept: true },
          }),
        },
      ],
      [{ destination: () => captured.stream }],
      levelsOf(),
      {},
    );

    factory.create("orders").info(undefined, "probe");

    const record = JSON.parse(captured.lines[0] ?? "{}");
    expect([record.stage, record.kept]).toEqual(["second", true]);
  });

  // 不当中间人：redact 是 pino 的原生选项，原样递出就该原样生效。
  test("passes a native pino option straight through", () => {
    const captured = capturingStream();
    const factory = new PinoLoggerFactory(
      { options: { redact: ["secret"] } },
      [],
      [],
      [{ destination: () => captured.stream }],
      levelsOf(),
      {},
    );

    factory.create("orders").info({ secret: "hunter2" }, "probe");

    expect(JSON.parse(captured.lines[0] ?? "{}").secret).toBe("[Redacted]");
  });

  // 逐 logger 调级走门面的 LoggingSettings（RFC 0011 L5 勘误）：级别配置是门面词汇，
  // 换绑定不改配置——这条用例断言 pino 绑定原样吃下它。
  test("resolves a per-logger level from LoggingSettings ahead of the default", () => {
    const captured = capturingStream();
    const factory = new PinoLoggerFactory(
      {},
      [],
      [],
      [{ destination: () => captured.stream }],
      levelsOf(["orders", "payments"]),
      { defaultLevel: "error", levels: { orders: "debug" } },
    );

    factory.create("orders").debug(undefined, "kept");
    factory.create("payments").debug(undefined, "dropped");

    expect(captured.lines.map((line) => JSON.parse(line).name)).toEqual(["orders"]);
  });

  // 不变量 8 在这个绑定上尤其要紧：字段合并发生在调用 pino 之前，交给 pino 短路等于每条
  // 关闭的日志仍付一次集合注入遍历的钱。
  test("never consults a field source below the threshold", () => {
    let calls = 0;
    const captured = capturingStream();
    const factory = new PinoLoggerFactory(
      {},
      [
        {
          fields() {
            calls += 1;
            return { traceId: "probe" };
          },
        },
      ],
      [],
      [{ destination: () => captured.stream }],
      levelsOf(),
      { defaultLevel: "error" },
    );

    factory.create("orders").debug(undefined, "dropped");

    expect(calls).toBe(0);
  });
});
