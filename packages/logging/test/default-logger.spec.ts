import { describe, expect, test } from "vitest";
import { loggerConformanceCases } from "@/conformance";
import type { LogFieldSource, LogRecord, LogThreshold } from "@/contracts";
import { DefaultLoggerFactory } from "@/default-logger";
import { LoggerLevels } from "@/levels";

// 写出的是 JSON 行，测试把它解析回记录形状消费——这样断言的是「线上真的写了什么」，
// 而不是内部对象。
function collecting(input: {
  readonly defaultLevel: LogThreshold;
  readonly fieldSources: readonly LogFieldSource[];
}) {
  const lines: string[] = [];
  const factory = new DefaultLoggerFactory({
    defaultLevel: input.defaultLevel,
    fieldSources: input.fieldSources,
    write: (line) => lines.push(line),
    now: () => 1_700_000_000_000,
  });
  const records = (): readonly LogRecord[] =>
    lines.map((line) => {
      const { level, name, time, message, ...fields } = JSON.parse(line);
      return { level, name, time, message, fields };
    });
  return { factory, records };
}

describe("default logger factory conformance", () => {
  for (const item of loggerConformanceCases({ name: "default", create: collecting })) {
    test(item.name, () => {
      item.run();
    });
  }
});

describe("default logger", () => {
  // 不变量 8 在本实现上再钉一次：conformance 是给每个绑定跑的通用约束，这里断言的是
  // 默认绑定连 JSON.stringify 都不会执行。
  test("does not serialise anything below the threshold", () => {
    let writes = 0;
    const factory = new DefaultLoggerFactory({
      defaultLevel: "error",
      write: () => {
        writes += 1;
      },
    });

    factory.create("orders").debug({ big: "payload" }, "skipped");

    expect(writes).toBe(0);
  });

  test("resolves a per-logger threshold ahead of the default", () => {
    const lines: string[] = [];
    const factory = new DefaultLoggerFactory({
      defaultLevel: "error",
      levelFor: (name) => (name === "orders" ? "debug" : "error"),
      write: (line) => lines.push(line),
    });

    factory.create("orders").debug(undefined, "kept");
    factory.create("payments").debug(undefined, "dropped");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ name: "orders", message: "kept" });
  });

  // A1（RFC 0011 L5，#249）：编译期快照接到默认绑定上的那一步。这是 `logging.level.*` 在
  // 默认绑定这条链路上真正生效的唯一证据。
  test("takes a per-logger threshold from the compile-time level snapshot", () => {
    const lines: string[] = [];
    const factory = new DefaultLoggerFactory({
      defaultLevel: "error",
      levels: new LoggerLevels({
        names: ["orders", "payments"],
        levels: { orders: "debug" },
        defaultLevel: "info",
        layers: [".env"],
      }),
      write: (line) => lines.push(line),
    });

    factory.create("orders").debug(undefined, "kept");
    factory.create("payments").debug(undefined, "dropped");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ name: "orders", message: "kept" });
  });

  // 快照没有逐个指定时不该顶掉用户显式写的 defaultLevel——这正是 explicitLevelFor 存在的理由。
  test("leaves the binding's own default in charge of a logger the snapshot skips", () => {
    const lines: string[] = [];
    const factory = new DefaultLoggerFactory({
      defaultLevel: "trace",
      levels: new LoggerLevels({
        names: ["orders"],
        levels: {},
        defaultLevel: "error",
        layers: [],
      }),
      write: (line) => lines.push(line),
    });

    factory.create("orders").trace(undefined, "kept");

    expect(lines).toHaveLength(1);
  });

  // 显式配置（RFC 0011 L5 勘误）：settings.levels 的逐 logger 指定压过快照与一切缺省。
  test("lets settings.levels win over the compile-time snapshot for a named logger", () => {
    const lines: string[] = [];
    const factory = new DefaultLoggerFactory({
      settings: { levels: { orders: "silent" } },
      levels: new LoggerLevels({
        names: ["orders"],
        levels: { orders: "debug" },
        defaultLevel: "info",
        layers: [],
      }),
      write: (line) => lines.push(line),
    });

    factory.create("orders").error(undefined, "dropped");

    expect(lines).toEqual([]);
  });

  test("falls back to settings.defaultLevel for a logger no one names", () => {
    const lines: string[] = [];
    const factory = new DefaultLoggerFactory({
      settings: { defaultLevel: "warn" },
      write: (line) => lines.push(line),
    });

    factory.create("orders").info(undefined, "dropped");
    factory.create("orders").warn(undefined, "kept");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ message: "kept" });
  });

  // Error 的 message/stack 都是不可枚举的，不特判会被 stringify 成 {}。
  test("renders a reserved err field instead of serialising it away", () => {
    const lines: string[] = [];
    const factory = new DefaultLoggerFactory({ write: (line) => lines.push(line) });

    factory.create("orders").error({ err: new Error("boom") }, "failed");

    expect(JSON.parse(lines[0] ?? "{}").err).toMatchObject({ name: "Error", message: "boom" });
  });
});
