import { Injectable, type OnContextClose } from "@reforce/context";
import {
  bindLoggerLevels,
  type LogFieldSource,
  type LogFields,
  type Logger,
  type LoggerFactory,
  type LoggerLevels,
  type LoggingSettings,
  type LogLevel,
  type LogThreshold,
} from "@reforce/logging";
// destination 挂在默认导出上，不在具名 pino 上（pino 10 的类型如此）。
import pinoDefault, { type LoggerOptions, type Logger as PinoLogger, pino } from "pino";
import type { PinoConfigurer, PinoDestinationProvider } from "@/bridges";
import type { PinoSettings } from "@/settings";

// pino 绑定（RFC 0011 L4，#242）。级别刻度与门面完全一致（trace 10 … fatal 60），所以
// 这里没有级别翻译层——`logLevelValues` 取的就是 pino 的刻度，正是为了让这一层是恒等的。

// 不变量 8（L1）：级别关闭时立即返回，不合并字段、不遍历 LogFieldSource、不序列化。
//
// pino 自己也会按级别短路，但那是在**拿到实参之后**——字段合并发生在调用 pino 之前，所以
// 判定必须由这一层先做。把它交给 pino 等于每条关闭的日志仍付一次集合注入遍历的钱。
class PinoBoundLogger implements Logger {
  private readonly delegate: PinoLogger;
  private readonly fieldSources: readonly LogFieldSource[];

  constructor(delegate: PinoLogger, fieldSources: readonly LogFieldSource[]) {
    this.delegate = delegate;
    this.fieldSources = fieldSources;
  }

  isEnabled(level: LogLevel): boolean {
    return this.delegate.isLevelEnabled(level);
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
    if (!this.delegate.isLevelEnabled(level)) {
      return;
    }
    // 字段对象作第一实参、消息作第二实参，正是 pino 的原生签名——门面的签名就是照它定的，
    // 所以这里没有重排。err 走 pino 的 serializers 特判，不在这层拆开。
    this.delegate[level](this.merged(fields), message);
  }

  // 集合为空时整段合并不发生（RFC 0011 L4）：成员是编译期封闭的，没有贡献者的应用不该在
  // 每条日志上付一次遍历加一次对象分配——那正是「门面吃掉 pino 的性能优势」的形状（风险 2）。
  private merged(fields: LogFields | undefined): LogFields {
    if (this.fieldSources.length === 0) {
      return fields ?? {};
    }
    const merged: Record<string, unknown> = {};
    for (const source of this.fieldSources) {
      Object.assign(merged, source.fields());
    }
    Object.assign(merged, fields);
    return merged;
  }
}

// 集合注入取「最多一个」的那一个：两个 sink 意味着日志要写两份，那是 pino 的 multistream
// 该做的事。空集合是合法的集合注入（不是 MISSING_BEAN），所以缺省能落回 fd 2。
function soleDestination(
  providers: readonly PinoDestinationProvider[],
): PinoDestinationProvider | undefined {
  if (providers.length > 1) {
    throw new Error(
      `Exactly one PinoDestinationProvider may be registered; found ${providers.length}. Use pino's multistream inside a single provider if you need to write twice.`,
    );
  }
  return providers.at(0);
}

// starter bean（ADR 0004 决策 4）：@Injectable() 是它进 reforce-meta.json 的唯一途径——
// 没有它，`defineApplication({ starters: [logging] })` 之后 LoggerFactory 仍然是 MISSING_BEAN，
// 两座桥也永远不会被调用。构造参数即 starter meta 的开放依赖边，形状照 web-hono 的 WebEngine。
@Injectable()
export class PinoLoggerFactory implements LoggerFactory, OnContextClose {
  private readonly root: PinoLogger;
  private readonly fieldSources: readonly LogFieldSource[];
  private readonly levelFor: (name: string) => LogThreshold | undefined;

  constructor(
    settings: PinoSettings,
    // 三条集合边：0 个 / 1 个 / N 个都合法（空集合是合法的集合注入，不是 MISSING_BEAN），
    // 成员顺序由编译期的 @Order + beanId 决定。
    fieldSources: readonly LogFieldSource[],
    configurers: readonly PinoConfigurer[],
    destinations: readonly PinoDestinationProvider[],
    // 编译器合成的级别快照（RFC 0011 L5，#249）。位序按追加历史排布：starter meta 的依赖边
    // 按数组位定 parameterIndex，追加不会挪动既有各条边。
    levels: LoggerLevels,
    // 门面的级别配置（RFC 0011 L5 勘误，#242）：defaultLevel 与逐 logger 的 levels 都从这里
    // 来，PinoSettings 收缩为纯 pino 原生选项。两个绑定共用这份词汇——换绑定不改级别配置。
    loggingSettings: LoggingSettings,
  ) {
    this.fieldSources = fieldSources;
    this.levelFor = bindLoggerLevels({ settings: loggingSettings, levels });
    const base: LoggerOptions = {
      ...settings.options,
      ...(loggingSettings.defaultLevel === undefined
        ? {}
        : { level: loggingSettings.defaultLevel }),
    };
    // configurer 依次改写，后一个拿到前一个的产物：顺序敏感度因此是可见的，而不是
    // 「谁最后写谁赢」的隐式竞争。
    const configured = configurers.reduce(
      (current, configurer) => configurer.configure(current),
      base,
    );
    // 缺省目标是 **fd 2**，不是裸 pino 的 stdout。理由与默认绑定同一条（default-logger.ts）：
    // stdout 属于应用数据面。两个绑定的缺省流必须一致，否则换绑定会让框架输出在 stdout 与
    // stderr 之间悄悄搬家。这不是当中间人——用户给了 destinationProvider 就原样用它，这里
    // 只是挑了个缺省；pino 自己的缺省也正是 `pino.destination(1)`，同一个机制换了个 fd。
    const destination = soleDestination(destinations)?.destination() ?? pinoDefault.destination(2);
    this.root = pino(configured, destination);
  }

  create(name: string): Logger {
    // 逐 logger 调级（RFC 0011 L5 勘误，#242）：级别的唯一真相是 LoggingSettings.levels，
    // 解析收在 bindLoggerLevels 里，两个绑定共用同一套优先级与启动期 warn。
    const level = this.levelFor(name);
    // pino 的 child 在这里是实现细节而不是门面特性：它给的是「同一个 sink、带 name 字段」，
    // 正是 logger 名需要的。门面首版不出 child(bindings) 是另一回事（Rule of Three）。
    const child = this.root.child({ name }, level === undefined ? {} : { level });
    return new PinoBoundLogger(child, this.fieldSources);
  }

  /**
   * 排空异步 sink（RFC 0011 L7/C2，#250）：sonic-boom 的写是异步的，不排空就会把最后几条
   * 日志跟进程一起丢掉。pino 的 flush 转交给具体 destination，所以 `pino.transport()` 起的
   * worker thread 也在覆盖范围内（走 thread-stream 自己的 flush(cb)）。
   *
   * 首版刻意不出这个公开方法，理由是「方法存在不等于有人调它」——当时它确实是死代码。现在
   * 有了第二个、且不走生命周期的调用方（崩溃接管在 process.exit 之前排空），那个条件已经
   * 满足。它不是唯一防线：pino 自己也注册了退出期的 flushSync，但用户自带的
   * PinoDestinationProvider 没有这个保证，而不变量 9 不允许把最吵的那条记录押在第三方的
   * 退出钩子上。
   */
  async flush(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.root.flush(() => resolve());
    });
  }

  async onContextClose(): Promise<void> {
    await this.flush();
  }
}
