import {
  isLevelEnabled,
  type LogFieldSource,
  type LogFields,
  type Logger,
  type LoggerFactory,
  type LogLevel,
  type LogRecord,
} from "@/contracts";

// 默认绑定（RFC 0011 L3，#242）：JSON.stringify 加一次同步写，零依赖。
//
// 文档必须诚实写明它的定位：够开发期与中小流量。pino 的真实价值是 sonic-boom 的异步写与
// worker thread transport——高吞吐场景换 @reforce/logging-pino，不要指望这里追平。

export interface DefaultLoggerFactoryOptions {
  /** 逐 logger 名的级别；未列出的走 defaultLevel。 */
  readonly levelFor?: (name: string) => LogLevel;
  readonly defaultLevel?: LogLevel;
  /** 集合注入的字段贡献者（ADR 0006 W6）。 */
  readonly fieldSources?: readonly LogFieldSource[];
  readonly write?: (line: string) => void;
  readonly now?: () => number;
}

function defaultWrite(line: string): void {
  process.stdout.write(`${line}\n`);
}

// 不变量 8 是实现约束，不是优化（L1）：级别关闭时不合并字段、不遍历 LogFieldSource、
// 不序列化。测试用带计数器的 LogFieldSource 硬断言零调用——把它当「优化」写，第一次重构
// 就会把 `const merged = this.merge(fields)` 提到判定之前，而那正是日志最贵的一步。
class DefaultLogger implements Logger {
  private readonly name: string;
  private readonly threshold: LogLevel;
  private readonly fieldSources: readonly LogFieldSource[];
  private readonly write: (line: string) => void;
  private readonly now: () => number;

  constructor(input: {
    readonly name: string;
    readonly threshold: LogLevel;
    readonly fieldSources: readonly LogFieldSource[];
    readonly write: (line: string) => void;
    readonly now: () => number;
  }) {
    this.name = input.name;
    this.threshold = input.threshold;
    this.fieldSources = input.fieldSources;
    this.write = input.write;
    this.now = input.now;
  }

  isEnabled(level: LogLevel): boolean {
    return isLevelEnabled(level, this.threshold);
  }

  trace(fields: LogFields | undefined, message: string): void {
    this.emit("trace", fields, message);
  }

  debug(fields: LogFields | undefined, message: string): void {
    this.emit("debug", fields, message);
  }

  info(fields: LogFields | undefined, message: string): void {
    this.emit("info", fields, message);
  }

  warn(fields: LogFields | undefined, message: string): void {
    this.emit("warn", fields, message);
  }

  error(fields: LogFields | undefined, message: string): void {
    this.emit("error", fields, message);
  }

  fatal(fields: LogFields | undefined, message: string): void {
    this.emit("fatal", fields, message);
  }

  private emit(level: LogLevel, fields: LogFields | undefined, message: string): void {
    if (!isLevelEnabled(level, this.threshold)) {
      return;
    }
    this.write(JSON.stringify(renderRecord(this.record(level, fields, message))));
  }

  private record(level: LogLevel, fields: LogFields | undefined, message: string): LogRecord {
    const merged: Record<string, unknown> = {};
    for (const source of this.fieldSources) {
      Object.assign(merged, source.fields());
    }
    Object.assign(merged, fields);
    return { level, name: this.name, time: this.now(), message, fields: merged };
  }
}

// err 是保留字段名：Error 不是 JSON 可序列化的（message/stack 都是不可枚举的），不特判就
// 会被 stringify 成 {}。
function renderRecord(record: LogRecord): Readonly<Record<string, unknown>> {
  const { err, ...rest } = record.fields;
  return {
    level: record.level,
    time: record.time,
    name: record.name,
    message: record.message,
    ...rest,
    ...(err instanceof Error
      ? { err: { name: err.name, message: err.message, stack: err.stack } }
      : err === undefined
        ? {}
        : { err }),
  };
}

export class DefaultLoggerFactory implements LoggerFactory {
  private readonly options: DefaultLoggerFactoryOptions;

  constructor(options: DefaultLoggerFactoryOptions = {}) {
    this.options = options;
  }

  create(name: string): Logger {
    return new DefaultLogger({
      name,
      threshold: this.options.levelFor?.(name) ?? this.options.defaultLevel ?? "info",
      fieldSources: this.options.fieldSources ?? [],
      write: this.options.write ?? defaultWrite,
      now: this.options.now ?? (() => Date.now()),
    });
  }
}

export { renderRecord };
