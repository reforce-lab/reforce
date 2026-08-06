import { bootstrapLogger } from "@/bootstrap-registry";
import type { Logger, LogLevel } from "@/contracts";
import type { LoggerLevels } from "@/levels";

// 编译期快照接到绑定上的那一步（RFC 0011 L5，#249 的「未做」第一条）。
//
// 在这一步存在之前，`LoggerLevels` 是运行期零消费者的：编译器校验 `logging.level.*` 的拼写、
// 给 did-you-mean、把封闭名单写进快照，但没有任何代码读那个快照——用户改了级别不生效，而
// 编译期的安静让人以为生效了。
//
// 两个绑定（默认绑定与 pino）共用这一处，不是为了省行数：级别解析的优先级顺序和启动期
// warn 的措辞一旦各写一遍，换绑定就会换一套行为，而「换绑定不改语义」正是门面的存在理由。

/** 框架自己那条 logger：级别相关的启动期 warn 从它出。 */
const levelsLoggerName = "reforce.logging";

export interface LevelBindingInput {
  /** 编译器合成的快照 bean；没有它就退回绑定自己的缺省级别。 */
  readonly levels?: LoggerLevels;
  /** 运行期环境，缺省 `process.env`（L5 表第三行：CI/生产注入的那一层）。 */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** 启动期 warn 的去处，缺省引导缓冲——容器起来之前它是唯一能用的入口（L7）。 */
  readonly report?: Logger;
}

/**
 * 返回逐 logger 的级别解析函数，并把快照与运行期环境对不上的地方一次性 warn 出去。
 *
 * 返回 `undefined` 而不是快照的 defaultLevel，是为了让绑定自己的缺省仍然说得上话：
 * pino 的 `PinoSettings.level` 与默认绑定的 `defaultLevel` 都是用户显式写的，快照没有逐个
 * 指定时不该把它们顶掉。
 */
export function bindLoggerLevels(
  input: LevelBindingInput = {},
): (name: string) => LogLevel | undefined {
  const levels = input.levels;
  if (levels === undefined) {
    return () => undefined;
  }
  const environment = input.environment ?? process.env;
  reportLevelSkew(levels, environment, input.report);
  return (name) => levels.explicitLevelFor(name, environment);
}

// 两族启动期 warn，都属于「编译期看不见的那一半」（L5 表第三行）：
//   1. process.env 注入了不认识的 LOGGING_LEVEL_*——编译期查不到，只能启动时说，带 did-you-mean。
//   2. REFORCE_PROFILE 指向的层不在编译期读过的层集里——那一层的级别从未被校验过。
// 两条都只 warn 不拦：级别写错一个字母应用照样跑，拦住启动是不成比例的惩罚。
function reportLevelSkew(
  levels: LoggerLevels,
  environment: Readonly<Record<string, string | undefined>>,
  report: Logger | undefined,
): void {
  const unknown = levels.unknownLoggerKeys(environment);
  const unverified = unverifiedProfileLayer(levels, environment);
  if (unknown.length === 0 && unverified === undefined) {
    return;
  }
  const log = report ?? bootstrapLogger(levelsLoggerName);
  for (const entry of unknown) {
    log.warn(
      {
        key: entry.key,
        ...(entry.suggestion === undefined ? {} : { suggestion: entry.suggestion }),
      },
      entry.suggestion === undefined
        ? `${entry.key} names no logger in this application; the level it sets is ignored.`
        : `${entry.key} names no logger in this application. Did you mean ${entry.suggestion}?`,
    );
  }
  if (unverified !== undefined) {
    log.warn(
      { layer: unverified, compiledLayers: levels.layers },
      `REFORCE_PROFILE selects ${unverified}, which was not read when this application was compiled; logger names in it went unchecked.`,
    );
  }
}

// `reforce build` 与 `reforce start` 的 REFORCE_PROFILE 可能不同（compiler/src/project/env-layers.ts
// 的层顺序注释写明了这一点）。快照里的 layers 是编译期实际读过的那几层，比对它而不是重新
// 猜一遍文件是否存在：存在与否不是重点，「编译期有没有校验过这一层」才是。
function unverifiedProfileLayer(
  levels: LoggerLevels,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const profile = environment.REFORCE_PROFILE?.trim();
  if (profile === undefined || profile.length === 0) {
    return undefined;
  }
  const layer = `.env.${profile}`;
  return levels.layers.includes(layer) ? undefined : layer;
}
