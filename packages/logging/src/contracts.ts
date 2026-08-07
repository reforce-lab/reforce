// 日志门面（RFC 0011 L1/L2，#242）。签名的每一处取舍都有具体理由，不是风格偏好：
//
// - 字段在前、消息在后（`log.info({orderId}, "created")`）：结构化字段是主角，消息是给人读的
//   标签。字段在后会让长字段对象把消息挤出视野，也让「只有消息、没有字段」和「两个都有」的
//   调用长得不一样。
// - 不透出 printf 插值（`log.info("user %s", id)`）：它把格式化推迟到写出时刻，等于要求每个
//   实现都自带一套格式化方言；模板字符串已经够用，而且级别关闭时连字符串都不必拼。
// - `err` 是保留字段名：几乎所有后端（pino、bunyan、OTel）都按这个名字特判 Error 的序列化，
//   换个名字等于主动放弃它们的堆栈处理。
// - 首版不出 `child(bindings)`：Rule of Three，且 L8 已确认 Fastify 不构成理由。

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

// 数值只用于比较，不进任何产物：级别之间只需要一个全序。取 pino 的刻度是为了让
// logging-pino 的映射是恒等的，少一层翻译。
export const logLevelValues = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const satisfies Record<LogLevel, number>;

export const logLevelNames: readonly LogLevel[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
];

// `silent` 是**阈值**，不是级别（RFC 0011 L1：六档 + silent，数值 ∞）。两者分成两个类型不是
// 洁癖：`log.silent(...)` 不存在，写得出来的调用只有六个，而「把这条 logger 关掉」是配置面
// 最常用的一档。合成一个类型会让 Logger 接口凭空多出一个不该存在的方法签名位。
export type LogThreshold = LogLevel | "silent";

// ∞ 让「关掉」不需要一个特判分支：任何级别与它比较都是 false，这正是 pino 的做法。
export const logThresholdValues = {
  ...logLevelValues,
  silent: Number.POSITIVE_INFINITY,
} as const satisfies Record<LogThreshold, number>;

export const logThresholdNames: readonly LogThreshold[] = [...logLevelNames, "silent"];

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  trace(fields: LogFields | undefined, message: string): void;
  debug(fields: LogFields | undefined, message: string): void;
  info(fields: LogFields | undefined, message: string): void;
  warn(fields: LogFields | undefined, message: string): void;
  error(fields: LogFields | undefined, message: string): void;
  fatal(fields: LogFields | undefined, message: string): void;
  // 出 isEnabled 是因为「构造字段本身就很贵」是真实场景（序列化一个大对象、算一次 hash）。
  // 没有它，调用方只能靠猜或者付出代价。
  isEnabled(level: LogLevel): boolean;
}

export interface LoggerFactory {
  create(name: string): Logger;
  /**
   * 排空异步 sink（RFC 0011 C2/L7，#250）。可选：同步写的绑定没有可排空的东西，硬声明一个
   * 恒 resolve 的方法只会让「这个绑定到底会不会丢日志」变得看不出来。
   *
   * 挂在 factory 上而不是 Logger 上——排空的是 sink，不是某一条 logger。
   */
  flush?(): Promise<void>;
}

// 集合注入（ADR 0006 W6）：每个实现贡献一组随每条记录合并的字段，典型是 trace id。返回
// undefined 表示「这次没有字段」，比返回空对象省一次合并。
export interface LogFieldSource {
  fields(): LogFields | undefined;
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly name: string;
  /** epoch 毫秒。 */
  readonly time: number;
  readonly message: string;
  readonly fields: LogFields;
}

export function isLevelEnabled(level: LogLevel, threshold: LogThreshold): boolean {
  return logLevelValues[level] >= logThresholdValues[threshold];
}
