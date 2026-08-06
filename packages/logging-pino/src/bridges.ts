import type { DestinationStream, LoggerOptions } from "pino";

// 两座桥（形状照 web-hono 的 HonoConfigurer / HonoRouteCustomizer，#236）。reforce 只提供
// 机制，不定义自己的词汇——`options` 和 `DestinationStream` 都是 pino 的原生类型。
//
// 实现类是普通 @Injectable() bean，不是角色 bean（角色是编译器硬编码的四值闭集，第三方包
// 扩展不了）。因此它们正常进集合注入，写 0 个 / 1 个 / N 个都合法。
//
// 每座桥同时导出方法形态的接口与字段形态的类型（惯例见 #219）：接口是文档默认，字段形态给
// 零标注写法一条路——TS 只在「类字段 + 箭头函数」位置做上下文类型化，方法形态的 implements
// 下参数会塌成 any。

/**
 * 选项 configurer：构造 pino 实例**之前**依次调用，可以逐层改写选项。
 *
 * ```ts
 * @Injectable()
 * export class Redaction implements PinoConfigurer {
 *   configure: PinoConfigure = (options) => ({
 *     ...options,
 *     redact: ["req.headers.authorization"],
 *   });
 * }
 * ```
 *
 * 返回新对象而不是就地改：多个 configurer 之间的顺序敏感度因此可见——后一个拿到的是前一个
 * 的产物，而不是「谁最后写谁赢」的隐式竞争。
 */
export interface PinoConfigurer {
  configure(options: LoggerOptions): LoggerOptions;
}

/** {@link PinoConfigurer.configure} 的字段形态，写成类字段即可免去参数标注。 */
export type PinoConfigure = (options: LoggerOptions) => LoggerOptions;

/**
 * 目标流提供者：交出 pino 要写进去的流。缺省是 pino 自己的 stdout。
 *
 * 高吞吐场景在这里给 `sonic-boom`，或给 `pino.transport({...})` 起 worker thread——
 * 两者都是 pino 的原生用法，本包不包装。
 *
 * ```ts
 * @Injectable()
 * export class FileSink implements PinoDestinationProvider {
 *   destination: PinoDestination = () => pino.destination("./app.log");
 * }
 * ```
 *
 * 最多一个：两个 sink 意味着日志要写两份，那是 pino 的 multistream 该做的事，
 * 在这里用集合会让「写去哪」变成不确定的。
 */
export interface PinoDestinationProvider {
  destination(): DestinationStream;
}

/** {@link PinoDestinationProvider.destination} 的字段形态。 */
export type PinoDestination = () => DestinationStream;
