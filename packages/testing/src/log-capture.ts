import type { LogFields, Logger, LoggerFactory, LogLevel, LogRecord } from "@reforce/logging";

// 日志捕获（RFC 0011 L9，#242）：断言「这条路径写了什么日志」的测试面。
//
// 实现就是「替换掉 LoggerFactory bean 的替身」，不新增任何机制——ADR 0007 T3 的
// 「testing 不新增任何校验通道」照旧成立。用法：
//
//   const capture = createLogCapture();
//   const context = await createTestContext(definition, (overrides) => {
//     overrides.replace(AppLoggerFactory, capture.factory);
//   });
//   expect(capture.records({ level: "error" })).toHaveLength(1);
//
// **已知代价**：createTestContext 的 replaceCreate 会把被替换 bean 的生命周期钩子换成
// no-op，所以这个 factory 拿不到 flush 语义。对捕获场景无害（本来就不需要 flush），但不能
// 拿它测关停期 flush——那条路径要用真实绑定。
//
// @reforce/logging 只进 devDependencies 且只做 import type：verbatimModuleSyntax 会把它
// 完全擦除，@reforce/testing 因此不会硬依赖日志包——不写日志的应用不该为它多装一个包。

export interface LogRecordQuery {
  readonly level?: LogLevel;
  readonly name?: string;
}

export interface LogCapture {
  /** 交给 overrides.replace() 的 LoggerFactory 替身。 */
  readonly factory: LoggerFactory;
  /** 按查询过滤已捕获的记录；无参即全部，顺序即写入顺序。 */
  records(query?: LogRecordQuery): readonly LogRecord[];
  clear(): void;
}

export interface LogCaptureOptions {
  /** 低于此级别的记录不被捕获；缺省 trace，即全收。 */
  readonly level?: LogLevel;
  /** 固定时间戳，便于断言；缺省取真实时钟。 */
  readonly now?: () => number;
}

const levelValues = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const satisfies Record<LogLevel, number>;

export function createLogCapture(options: LogCaptureOptions = {}): LogCapture {
  const captured: LogRecord[] = [];
  const threshold = levelValues[options.level ?? "trace"];
  const now = options.now ?? (() => Date.now());
  const enabled = (level: LogLevel) => levelValues[level] >= threshold;

  const create = (name: string): Logger => {
    const emit = (level: LogLevel) => (fields: LogFields | undefined, message: string) => {
      // 与真实绑定同一条不变量（不变量 8）：级别关闭时立即返回，不合并字段。捕获替身若
      // 无条件记录，用「关掉级别后没有日志」这类断言就永远测不出问题。
      if (!enabled(level)) {
        return;
      }
      captured.push({ level, name, time: now(), message, fields: fields ?? {} });
    };
    return {
      isEnabled: enabled,
      trace: emit("trace"),
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      fatal: emit("fatal"),
    };
  };

  return {
    factory: { create },
    records(query) {
      return captured.filter(
        (record) =>
          (query?.level === undefined || record.level === query.level) &&
          (query?.name === undefined || record.name === query.name),
      );
    },
    clear() {
      captured.splice(0);
    },
  };
}
