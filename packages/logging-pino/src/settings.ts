import type { LoggerOptions } from "pino";

// 开放契约边（ADR 0005 先例，同 WebHonoServeSettings）：starter 声明契约，应用用
// `class ... extends ConfigProperties("logging", schema) implements PinoSettings` 闭合。
//
// **不当中间人**（RFC 0011 L4，#242）：这里刻意不定义 reforce 自己的日志配置词汇。
// redact / serializers / formatters / transport 全是 pino 的原生类型原样递出——用户查的是
// pino 的文档，写的是 pino 的写法，升级 pino 时新增的选项不需要本包跟着改一遍。
//
// 级别不在这里（RFC 0011 L5 勘误，#242）：defaultLevel 与逐 logger 的 levels 是门面词汇，
// 归 @reforce/logging 的 LoggingSettings——换绑定不改级别配置，正是门面的存在理由。
//
// 反面教材是「框架自定义一套配置名再翻译成 pino 的」：翻译层永远落后于上游，且把「pino 支持
// 什么」这个问题变成「reforce 翻译了什么」，用户得同时读两份文档。
export interface PinoSettings {
  /**
   * 原样交给 `pino()` 的选项。本包只在两处覆盖它：`level` 由门面的 LoggingSettings 与逐
   * logger 解析结果决定，`name` 由 logger 名决定——这两个正是门面负责的部分，其余一律
   * 用户说了算。
   */
  readonly options?: Omit<LoggerOptions, "level" | "name">;
}
