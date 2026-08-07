import {
  isLevelEnabled,
  type LogFieldSource,
  type LogFields,
  type Logger,
  type LoggerFactory,
  type LogLevel,
  type LogRecord,
  type LogThreshold,
} from "@/contracts";
import { bindLoggerLevels } from "@/level-binding";
import type { LoggerLevels } from "@/levels";
import { renderRecord } from "@/render-record";
import type { LoggingSettings } from "@/settings";

// 默认绑定（RFC 0011 L3，#242）：JSON.stringify 加一次同步写，零依赖。
//
// 文档必须诚实写明它的定位：够开发期与中小流量。pino 的真实价值是 sonic-boom 的异步写与
// worker thread transport——高吞吐场景换 @reforce/logging-pino，不要指望这里追平。

export interface DefaultLoggerFactoryOptions {
  /**
   * 应用的显式级别配置（RFC 0011 L5 勘误）：settings.levels 的逐 logger 指定最优先，
   * settings.defaultLevel 兜没逐个指定的部分。拼错的 logger 名对快照名单 warn。
   */
  readonly settings?: LoggingSettings;
  /**
   * 编译器合成的级别快照 bean（RFC 0011 L5，#249）。给了它，`logging.level.*` 与
   * `LOGGING_LEVEL_<NAME>` 才真正生效——这是把编译期校验过的名单接到运行期的那根线。
   */
  readonly levels?: LoggerLevels;
  /** 逐 logger 名的级别；返回 undefined 表示「这条没配」，交给 defaultLevel。 */
  readonly levelFor?: (name: string) => LogThreshold | undefined;
  readonly defaultLevel?: LogThreshold;
  /** 集合注入的字段贡献者（ADR 0006 W6）。 */
  readonly fieldSources?: readonly LogFieldSource[];
  readonly write?: (line: string) => void;
  readonly now?: () => number;
}

// 缺省写 **stderr** 而不是 stdout——这与裸 pino 的缺省相反，是本仓既有的不变量而不是口味：
// 生成的 bootstrap 会被当作库嵌进 Worker/管道消费，stdout 属于应用数据面必须保持纯净，所以
// 三个引擎的监听行、@reforce/config 的绑定警告、reporter 的诊断，现有运行期输出全在 stderr。
// 框架自己的日志一旦改走这个门面（RFC 0011 L8），缺省写 stdout 就等于把那条不变量悄悄破掉。
// 要 stdout 的应用显式传 write。
function defaultWrite(line: string): void {
  process.stderr.write(`${line}\n`);
}

// 不变量 8 是实现约束，不是优化（L1）：级别关闭时不合并字段、不遍历 LogFieldSource、
// 不序列化。测试用带计数器的 LogFieldSource 硬断言零调用——把它当「优化」写，第一次重构
// 就会把 `const merged = this.merge(fields)` 提到判定之前，而那正是日志最贵的一步。
class DefaultLogger implements Logger {
  private readonly name: string;
  private readonly threshold: LogThreshold;
  private readonly fieldSources: readonly LogFieldSource[];
  private readonly write: (line: string) => void;
  private readonly now: () => number;

  constructor(input: {
    readonly name: string;
    readonly threshold: LogThreshold;
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
    return { level, name: this.name, time: this.now(), message, fields: this.merged(fields) };
  }

  // 集合为空时整段合并不发生（RFC 0011 L4 的编译期优化：成员编译期封闭，空集合不该在热路径上
  // 留下一次遍历加一次对象分配）。集合成员由编译期定死，所以这个分支的结果对某个应用是常量。
  private merged(fields: LogFields | undefined): LogFields {
    if (this.fieldSources.length === 0) {
      return fields ?? {};
    }
    const merged: Record<string, unknown> = {};
    for (const source of this.fieldSources) {
      Object.assign(merged, source.fields());
    }
    // 调用点自己的字段压过收集来的：写在调用点的那个更具体，也更可能是这条日志的主语。
    Object.assign(merged, fields);
    return merged;
  }
}

export class DefaultLoggerFactory implements LoggerFactory {
  private readonly options: DefaultLoggerFactoryOptions;
  private readonly levelFor: (name: string) => LogThreshold | undefined;

  constructor(options: DefaultLoggerFactoryOptions = {}) {
    this.options = options;
    // settings/快照优先于手写的 levelFor：给了它们就是要显式配置说了算。levelFor 只在两者
    // 都缺席时说话——那个场合只出现在测试里，手写的那个正是被验证的对象。
    this.levelFor =
      options.settings === undefined && options.levels === undefined
        ? (options.levelFor ?? (() => undefined))
        : bindLoggerLevels({ settings: options.settings, levels: options.levels });
  }

  create(name: string): Logger {
    return new DefaultLogger({
      name,
      threshold:
        this.levelFor(name) ??
        this.options.settings?.defaultLevel ??
        this.options.defaultLevel ??
        "info",
      fieldSources: this.options.fieldSources ?? [],
      write: this.options.write ?? defaultWrite,
      now: this.options.now ?? (() => Date.now()),
    });
  }
}
