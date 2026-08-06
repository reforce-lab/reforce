import type { LogFieldSource, LogFields, Logger, LoggerFactory, LogLevel } from "@reforce/logging";
// destination 挂在默认导出上，不在具名 pino 上（pino 10 的类型如此）。
import pinoDefault, { type LoggerOptions, type Logger as PinoLogger, pino } from "pino";
import type { PinoConfigurer, PinoDestinationProvider } from "@/bridges";
import type { PinoSettings } from "@/settings";

// pino 绑定（RFC 0011 L4，#242）。级别刻度与门面完全一致（trace 10 … fatal 60），所以
// 这里没有级别翻译层——`logLevelValues` 取的就是 pino 的刻度，正是为了让这一层是恒等的。

export interface PinoLoggerFactoryOptions {
  readonly settings?: PinoSettings;
  /** 逐 logger 名解析出的级别；缺省走 settings.level。 */
  readonly levelFor?: (name: string) => LogLevel;
  readonly fieldSources?: readonly LogFieldSource[];
  readonly configurers?: readonly PinoConfigurer[];
  readonly destinationProvider?: PinoDestinationProvider;
}

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

  private merged(fields: LogFields | undefined): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const source of this.fieldSources) {
      Object.assign(merged, source.fields());
    }
    Object.assign(merged, fields);
    return merged;
  }
}

export class PinoLoggerFactory implements LoggerFactory {
  private readonly options: PinoLoggerFactoryOptions;
  private readonly root: PinoLogger;

  constructor(options: PinoLoggerFactoryOptions = {}) {
    this.options = options;
    const base: LoggerOptions = {
      ...options.settings?.options,
      ...(options.settings?.level === undefined ? {} : { level: options.settings.level }),
    };
    // configurer 依次改写，后一个拿到前一个的产物：顺序敏感度因此是可见的，而不是
    // 「谁最后写谁赢」的隐式竞争。
    const configured = (options.configurers ?? []).reduce(
      (current, configurer) => configurer.configure(current),
      base,
    );
    // 缺省目标是 **fd 2**，不是裸 pino 的 stdout。理由与默认绑定同一条（default-logger.ts）：
    // stdout 属于应用数据面。两个绑定的缺省流必须一致，否则换绑定会让框架输出在 stdout 与
    // stderr 之间悄悄搬家。这不是当中间人——用户给了 destinationProvider 就原样用它，这里
    // 只是挑了个缺省；pino 自己的缺省也正是 `pino.destination(1)`，同一个机制换了个 fd。
    const destination = options.destinationProvider?.destination() ?? pinoDefault.destination(2);
    this.root = pino(configured, destination);
  }

  create(name: string): Logger {
    const level = this.options.levelFor?.(name);
    // pino 的 child 在这里是实现细节而不是门面特性：它给的是「同一个 sink、带 name 字段」，
    // 正是 logger 名需要的。门面首版不出 child(bindings) 是另一回事（Rule of Three）。
    const child = this.root.child({ name }, level === undefined ? {} : { level });
    return new PinoBoundLogger(child, this.options.fieldSources ?? []);
  }

  /** 关停期 flush（L7）：pino 的异步写必须显式排空，否则最后几条日志随进程一起消失。 */
  async flush(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.root.flush(() => resolve());
    });
  }
}
