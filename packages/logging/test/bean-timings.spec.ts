import { describe, expect, test } from "vitest";
import { type BeanTimingRecord, beanTimingSections, emitBeanTimings } from "@/bean-timings";
import type { LogFields, LogLevel } from "@/contracts";

function timing(id: string, ms: number): BeanTimingRecord {
  return { id, phase: "construct", ms };
}

function capturingLogger(enabled: boolean) {
  const records: { fields: LogFields | undefined; message: string }[] = [];
  return {
    records,
    isEnabled: (level: LogLevel) => enabled && level === "debug",
    debug: (fields: LogFields | undefined, message: string) => {
      records.push({ fields, message });
    },
  };
}

describe("beanTimingSections", () => {
  test("produces no section when every bean is under the threshold", () => {
    const sections = beanTimingSections([timing("a", 0.4), timing("b", 4.9)], "reforce.web");

    expect(sections).toEqual([]);
  });

  test("names the slowest bean and counts every bean over the threshold", () => {
    const sections = beanTimingSections(
      [timing("src/infra/data-source.ts#DataSource", 96), timing("b", 12), timing("c", 0.4)],
      "reforce.web",
    );

    expect(sections[0]?.facts).toEqual(["2 over 5ms", "src/infra/data-source.ts#DataSource 96ms"]);
  });

  // 同样的启动跑两遍不能点名不同的 bean，否则读者会以为耗时在跳。
  test("breaks a tie for slowest by bean id so the fold is deterministic", () => {
    const sections = beanTimingSections([timing("zebra", 40), timing("alpha", 40)], "reforce.web");

    expect(sections[0]?.facts[1]).toBe("alpha 40ms");
  });

  // 不变量 4 的出口必须是真能跑的命令。61cfa9a 落的 `reforce explain routes` 跑不通，
  // 这条用例是不重蹈那个形状的守卫。
  test("derives the expand command from the emitting logger's own level key", () => {
    const sections = beanTimingSections([timing("a", 40)], "reforce.web");

    expect(sections[0]?.expandWith).toBe("LOGGING_LEVEL_REFORCE_WEB=debug reforce start");
  });
});

describe("emitBeanTimings", () => {
  // 不变量 8：级别判定在字段构造之前。logger 关着时连一次对象分配都不该发生。
  test("builds no record when debug is disabled", () => {
    const logger = {
      isEnabled: () => false,
      debug: () => {
        throw new Error("must not build a record when debug is off");
      },
    };

    expect(() => emitBeanTimings({ logger, timings: [timing("a", 40)] })).not.toThrow();
  });

  test("emits one debug record per timing in the order the container recorded them", () => {
    const logger = capturingLogger(true);

    emitBeanTimings({ logger, timings: [timing("a", 40), timing("b", 1)] });

    expect(logger.records.map((record) => record.fields?.bean)).toEqual(["a", "b"]);
  });

  test("carries the bean id, phase and duration on each record", () => {
    const logger = capturingLogger(true);

    emitBeanTimings({ logger, timings: [{ id: "a", phase: "start", ms: 12.5 }] });

    expect(logger.records[0]).toEqual({
      fields: { bean: "a", phase: "start", ms: 12.5 },
      message: "bean timing",
    });
  });
});
