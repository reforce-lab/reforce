import type { Logger, LogThreshold } from "@/contracts";
import { nearestName } from "@/did-you-mean";

// 显式级别配置（RFC 0011 L5 勘误，#242）：级别的真相是应用里的一个普通 bean，不是环境变量。
//
// 两条防线分工明确：
//   - 级别词拼错（"verbos"）= tsc 编译错误——LogThreshold 是封闭 union，env 通道永远做不到；
//   - logger 名拼错（"OrdrService"）= 启动期确定性 warn + did-you-mean——对编译器合成的
//     封闭名单（LoggerLevels.names）精确比对，每次启动必报（reportUnknownLoggerLevels）。
//
// 这份契约是门面词汇，默认绑定与 pino 绑定共用：换绑定不改级别配置，正是门面的存在理由。

/** 逐 logger 名的级别表。键是 logger 名（类名或 @LoggerName 字面量），值是封闭的级别词。 */
export type LoggerLevelMap = Readonly<Record<string, LogThreshold>>;

// "auto" 是缺省语义的显式拼写：TTY 出 human 行，管道/生产出 JSON（RFC 0011 D1 的应用侧默认表）。
export type LogRenderMode = "auto" | "human" | "json";

export interface LoggingSettings {
  /** 未逐个指定时的兜底级别；不写则由绑定自己兜底（默认绑定是 info）。 */
  readonly defaultLevel?: LogThreshold;
  /** 逐 logger 调级；键必须命中编译期封闭名单，否则启动期 warn。 */
  readonly levels?: LoggerLevelMap;
  /** 输出形态；不写等于 "auto"。仅默认绑定消费，pino 的输出形态归 pino 自己的 transport 管。 */
  readonly render?: LogRenderMode;
}

/**
 * starter 自带的全默认实现（defaultBean）：让「零配置可用」与「本地 bean 覆盖」用现有的
 * 候选裁决机制同时成立——应用写一个自己的 LoggingSettings bean，这个就自动让位。
 */
export class DefaultLoggingSettings implements LoggingSettings {}

export interface UnknownLoggerLevelKey {
  readonly key: string;
  readonly suggestion?: string;
}

/** settings.levels 里没命中封闭名单的键，带 did-you-mean。纯函数，warn 的发出在调用方。 */
export function unknownLoggerLevelKeys(
  levels: LoggerLevelMap | undefined,
  names: readonly string[],
): readonly UnknownLoggerLevelKey[] {
  if (levels === undefined) {
    return [];
  }
  const known = new Set(names);
  const unknown: UnknownLoggerLevelKey[] = [];
  for (const key of Object.keys(levels)) {
    if (known.has(key)) {
      continue;
    }
    const suggestion = nearestName(key, names);
    unknown.push(suggestion === undefined ? { key } : { key, suggestion });
  }
  return unknown;
}

/**
 * 把拼错的 logger 名一次性 warn 出去。只 warn 不拦：级别写错一个字母应用照样跑，
 * 拦住启动是不成比例的惩罚（与 env 时代的判据一致）。
 */
export function reportUnknownLoggerLevels(
  levels: LoggerLevelMap | undefined,
  names: readonly string[],
  report: Logger,
): void {
  for (const entry of unknownLoggerLevelKeys(levels, names)) {
    report.warn(
      {
        key: entry.key,
        ...(entry.suggestion === undefined ? {} : { suggestion: entry.suggestion }),
      },
      entry.suggestion === undefined
        ? `LoggingSettings.levels["${entry.key}"] names no logger in this application; the level it sets is ignored.`
        : `LoggingSettings.levels["${entry.key}"] names no logger in this application. Did you mean "${entry.suggestion}"?`,
    );
  }
}
