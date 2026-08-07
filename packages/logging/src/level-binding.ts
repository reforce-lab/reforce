import { bootstrapLogger } from "@/bootstrap-registry";
import type { Logger, LogThreshold } from "@/contracts";
import type { LoggerLevels } from "@/levels";
import { type LoggingSettings, reportUnknownLoggerLevels } from "@/settings";

// 显式级别配置接到绑定上的那一步（RFC 0011 L5 勘误，#242）。
//
// 两个绑定（默认绑定与 pino）共用这一处，不是为了省行数：级别解析的优先级顺序和启动期
// warn 的措辞一旦各写一遍，换绑定就会换一套行为，而「换绑定不改语义」正是门面的存在理由。

/** 框架自己那条 logger：级别相关的启动期 warn 从它出。 */
const levelsLoggerName = "reforce.logging";

export interface LevelBindingInput {
  /** 应用的显式级别配置 bean：settings.levels 的逐 logger 指定是级别的唯一真相。 */
  readonly settings?: LoggingSettings;
  /** 编译器合成的封闭名单 bean；有它才能对 settings.levels 的键做启动期 did-you-mean。 */
  readonly levels?: LoggerLevels;
  /** 启动期 warn 的去处，缺省引导缓冲——容器起来之前它是唯一能用的入口（L7）。 */
  readonly report?: Logger;
}

/**
 * 返回逐 logger 的级别解析函数，并把 settings.levels 里拼错的 logger 名对封闭名单
 * 精确比对后一次性 warn 出去（带 did-you-mean，每次启动必报）。
 *
 * 返回 `undefined` 而不是某个兜底级别，是为了让 `LoggingSettings.defaultLevel` 与绑定
 * 自己的缺省仍然说得上话：没有逐个指定这条 logger 时不该把它们顶掉。
 */
export function bindLoggerLevels(
  input: LevelBindingInput = {},
): (name: string) => LogThreshold | undefined {
  const { settings, levels } = input;
  if (settings?.levels !== undefined && levels !== undefined) {
    reportUnknownLoggerLevels(
      settings.levels,
      levels.names,
      input.report ?? bootstrapLogger(levelsLoggerName),
    );
  }
  return (name) => settings?.levels?.[name];
}
