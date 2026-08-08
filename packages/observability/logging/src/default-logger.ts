import type { Writable } from "node:stream";
import {
  isLevelEnabled,
  type LogFieldSource,
  type LogFields,
  type Logger,
  type LoggerFactory,
  type LogLevel,
  type LogRecord,
  type LogThreshold,
  renderRecord,
} from "@reforce/logging-contracts";
import { resolveRenderMode } from "@reforce/primitives/render-mode";
import { isInteractive } from "@reforce/primitives/terminal";
import { bindLoggerLevels } from "@/level-binding";
import type { LoggerLevels } from "@/levels";
import { createHumanRenderer } from "@/render-human";
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
  /** 编译器合成的封闭名单 bean：有它才能对 settings.levels 的键做启动期 did-you-mean。 */
  readonly levels?: LoggerLevels;
  /** 逐 logger 名的级别；返回 undefined 表示「这条没配」，交给 defaultLevel。 */
  readonly levelFor?: (name: string) => LogThreshold | undefined;
  readonly defaultLevel?: LogThreshold;
  /** 集合注入的字段贡献者（ADR 0006 W6）。 */
  readonly fieldSources?: readonly LogFieldSource[];
  readonly write?: (line: string) => void;
  /** 输出流：human/json 的 TTY 判定与颜色都按它算，缺省 process.stderr。 */
  readonly stream?: Writable;
  readonly now?: () => number;
}

// 缺省写 **stderr** 而不是 stdout——这与裸 pino 的缺省相反，是本仓既有的不变量而不是口味：
// 生成的 bootstrap 会被当作库嵌进 Worker/管道消费，stdout 属于应用数据面必须保持纯净，所以
// 三个引擎的监听行、@reforce/config 的绑定警告、reporter 的诊断，现有运行期输出全在 stderr。
// 框架自己的日志一旦改走这个门面（RFC 0011 L8），缺省写 stdout 就等于把那条不变量悄悄破掉。
// 要 stdout 的应用显式传 stream 或 write。

// 模式解析（RFC 0011 D1 的应用侧默认表）：settings.render 是应用侧的显式覆盖，"auto"/缺席时
// 走与 CLI 同一套 resolveRenderMode——audience 是 "application"（非 TTY 缺省 json，读者是
// 日志系统），TTY 下是 human。short 对结构化应用日志没有意义，env 强设它时落回 json。
function resolveRender(settings: LoggingSettings | undefined, stream: Writable): "human" | "json" {
  const explicit = settings?.render;
  if (explicit === "human" || explicit === "json") {
    return explicit;
  }
  const mode = resolveRenderMode({
    interactive: isInteractive(stream),
    audience: "application",
    env: process.env,
  });
  return mode === "human" ? "human" : "json";
}

// 不变量 8 是实现约束，不是优化（L1）：级别关闭时不合并字段、不遍历 LogFieldSource、
// 不序列化。测试用带计数器的 LogFieldSource 硬断言零调用——把它当「优化」写，第一次重构
// 就会把 `const merged = this.merge(fields)` 提到判定之前，而那正是日志最贵的一步。
class DefaultLogger implements Logger {
  private readonly name: string;
  private readonly threshold: LogThreshold;
  private readonly fieldSources: readonly LogFieldSource[];
  private readonly write: (line: string) => void;
  private readonly render: (record: LogRecord) => string;
  private readonly now: () => number;

  constructor(input: {
    readonly name: string;
    readonly threshold: LogThreshold;
    readonly fieldSources: readonly LogFieldSource[];
    readonly write: (line: string) => void;
    readonly render: (record: LogRecord) => string;
    readonly now: () => number;
  }) {
    this.name = input.name;
    this.threshold = input.threshold;
    this.fieldSources = input.fieldSources;
    this.write = input.write;
    this.render = input.render;
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
    this.write(this.render(this.record(level, fields, message)));
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
  private readonly write: (line: string) => void;
  private readonly render: (record: LogRecord) => string;

  constructor(options: DefaultLoggerFactoryOptions = {}) {
    this.options = options;
    // settings/快照优先于手写的 levelFor：给了它们就是要显式配置说了算。levelFor 只在两者
    // 都缺席时说话——那个场合只出现在测试里，手写的那个正是被验证的对象。
    this.levelFor =
      options.settings === undefined && options.levels === undefined
        ? (options.levelFor ?? (() => undefined))
        : bindLoggerLevels({ settings: options.settings, levels: options.levels });
    const stream = options.stream ?? process.stderr;
    this.write = options.write ?? ((line) => void stream.write(`${line}\n`));
    // human 渲染器整个 factory 共享一个：相对时间戳（+12ms）算的是相邻两条记录的间隔，
    // 逐 logger 各起一个时钟会让间隔失真。
    this.render =
      resolveRender(options.settings, stream) === "human"
        ? createHumanRenderer({ stream })
        : (record) => JSON.stringify(renderRecord(record));
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
      write: this.write,
      render: this.render,
      now: this.options.now ?? (() => Date.now()),
    });
  }
}
