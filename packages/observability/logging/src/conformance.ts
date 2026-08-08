import {
  type LogFieldSource,
  type LoggerFactory,
  type LogRecord,
  type LogThreshold,
  logLevelNames,
} from "@/contracts";

// LoggerFactory 一致性套件（RFC 0011 L3，#242）：门面的行为契约在每个绑定上都必须成立。
// 每条都对应一个真实的实现差异，不是凭空罗列——各家日志库在级别语义、保留字段和「关闭时
// 做多少工作」上分歧很大。
//
// 与 @reforce/web-core 的 conformance 同一形态：不 import vitest、不用 expect，只抛 Error。
// 那样 dist 里就不带 vitest 的 import，本包也不必把它从 devDependency 提成 peer。

export interface LoggerConformanceOptions {
  /** 绑定名，仅用于失败信息定位。 */
  readonly name: string;
  /**
   * 造一个工厂，并交出它写出的记录。fieldSources 必须原样接进实现的集合注入面——
   * 不变量 8 的断言全靠它。
   */
  create(input: {
    readonly defaultLevel: LogThreshold;
    readonly fieldSources: readonly LogFieldSource[];
  }): {
    readonly factory: LoggerFactory;
    readonly records: () => readonly LogRecord[];
  };
}

export interface LoggerConformanceCase {
  readonly name: string;
  run(): void;
}

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    fail(message);
  }
}

// 带计数器的字段贡献者：不变量 8 靠它硬断言零调用。
function countingFieldSource(): { readonly source: LogFieldSource; readonly calls: () => number } {
  let calls = 0;
  return {
    source: {
      fields() {
        calls += 1;
        return { traceId: "probe" };
      },
    },
    calls: () => calls,
  };
}

export function loggerConformanceCases(
  options: LoggerConformanceOptions,
): readonly LoggerConformanceCase[] {
  const label = (text: string) => `${options.name}: ${text}`;
  return [
    {
      name: "writes a record at or above the configured level",
      run() {
        const counting = countingFieldSource();
        const bound = options.create({ defaultLevel: "info", fieldSources: [counting.source] });
        bound.factory.create("orders").info({ orderId: 7 }, "created");

        const records = bound.records();
        assert(records.length === 1, label(`expected one record, got ${records.length}`));
        assert(records[0]?.message === "created", label("message must survive unchanged"));
        assert(records[0]?.name === "orders", label("record must carry its logger name"));
      },
    },
    {
      name: "drops a record below the configured level",
      run() {
        const counting = countingFieldSource();
        const bound = options.create({ defaultLevel: "warn", fieldSources: [counting.source] });
        bound.factory.create("orders").info({ orderId: 7 }, "created");

        assert(bound.records().length === 0, label("a below-threshold record must not be written"));
      },
    },
    {
      // 不变量 8：级别关闭时不合并字段、不遍历 LogFieldSource、不序列化。把它写成「优化」，
      // 第一次重构就会把合并提到判定之前——而那正是日志最贵的一步。
      name: "does no field work at all when the level is disabled",
      run() {
        const counting = countingFieldSource();
        const bound = options.create({ defaultLevel: "error", fieldSources: [counting.source] });
        const logger = bound.factory.create("orders");
        logger.trace(undefined, "t");
        logger.debug(undefined, "d");
        logger.info(undefined, "i");

        assert(
          counting.calls() === 0,
          label(`LogFieldSource was consulted ${counting.calls()} time(s) below the threshold`),
        );
      },
    },
    {
      name: "merges collected fields underneath the call site's own",
      run() {
        const counting = countingFieldSource();
        const bound = options.create({ defaultLevel: "info", fieldSources: [counting.source] });
        bound.factory.create("orders").info({ traceId: "explicit" }, "created");

        const fields = bound.records()[0]?.fields ?? {};
        assert(
          fields.traceId === "explicit",
          label("a call site's own field must win over a collected one"),
        );
      },
    },
    {
      // 空集合走的是「整段合并不发生」那条分支（L4 的编译期优化）。抄近路最容易抄掉的正是
      // 调用点自己的字段——省掉合并的同时把 fields 一起省了，而那是这条记录的全部内容。
      name: "still carries the call site's own fields with no sources at all",
      run() {
        const bound = options.create({ defaultLevel: "info", fieldSources: [] });
        bound.factory.create("orders").info({ orderId: 7 }, "created");

        const fields = bound.records()[0]?.fields ?? {};
        assert(fields.orderId === 7, label("the call site's own fields must survive an empty set"));
      },
    },
    {
      name: "reports isEnabled consistently with what it writes",
      run() {
        const bound = options.create({ defaultLevel: "warn", fieldSources: [] });
        const logger = bound.factory.create("orders");

        for (const level of logLevelNames) {
          const before = bound.records().length;
          logger[level](undefined, level);
          const wrote = bound.records().length > before;
          assert(
            wrote === logger.isEnabled(level),
            label(`isEnabled("${level}") disagrees with whether the record was written`),
          );
        }
      },
    },
    {
      // silent 是六档之上的第七个阈值（RFC 0011 L1，数值 ∞）。它必须在**每个**绑定上都是
      // 「一条都不写」，否则 `logging.level.X=silent` 的效果就取决于装了哪个绑定——而门面
      // 存在的理由正是换绑定不换语义。fatal 是最容易漏的那一档：任何「至少放行最高级别」的
      // 实现都会在这里露馅。
      name: "writes nothing at all when the threshold is silent",
      run() {
        const counting = countingFieldSource();
        const bound = options.create({ defaultLevel: "silent", fieldSources: [counting.source] });
        const logger = bound.factory.create("orders");

        for (const level of logLevelNames) {
          logger[level](undefined, level);
          assert(
            !logger.isEnabled(level),
            label(`isEnabled("${level}") must be false when silent`),
          );
        }

        assert(
          bound.records().length === 0,
          label(`silent wrote ${bound.records().length} record(s)`),
        );
        assert(counting.calls() === 0, label("silent must not consult a LogFieldSource"));
      },
    },
    {
      name: "keeps err as a reserved field carrying the error's identity",
      run() {
        const bound = options.create({ defaultLevel: "info", fieldSources: [] });
        bound.factory.create("orders").error({ err: new Error("boom") }, "failed");

        const err = bound.records()[0]?.fields.err;
        assert(err !== undefined, label("err must survive to the record"));
        const rendered = JSON.stringify(err);
        assert(
          rendered !== undefined && rendered.includes("boom"),
          label(`err must not serialise away its message, got ${String(rendered)}`),
        );
      },
    },
  ];
}
