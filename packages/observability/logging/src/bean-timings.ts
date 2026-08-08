import type { LogFields, LogLevel } from "@reforce/logging-contracts";
import type { StartupSummarySection } from "@/startup-summary";

// 启动台账的折叠规则与展开出口（RFC 0011 C6，#250）。
//
// 台账本身由 @reforce/core 的 start() 交出来，它不认识 @reforce/logging（package.json 里
// 零 @reforce 依赖，必须保持）。所以这里按结构声明它的形状，而不是 import 那边的类型——
// type-only import 会留在生成的 d.ts 里，等于把硬依赖藏在类型层（同 web 侧 RequestLogger 的
// 理由）。
export interface BeanTimingRecord {
  readonly id: string;
  readonly phase: string;
  readonly ms: number;
}

export interface BeanTimingLogger {
  isEnabled(level: LogLevel): boolean;
  debug(fields: LogFields | undefined, message: string): void;
}

// 5ms 不是凑整：本机实测启动期 GC 停顿中位 0.5ms、最长 3.3ms，而一个什么都不做的构造函数
// 是 0.0002ms 量级。低于 5ms 的条目分不清是真工作还是一次 GC 恰好落在计时区间里，点名它等于
// 让人去查一个不存在的问题。5ms 又低于任何真实 I/O（TCP 握手 ~1ms 起，数据库握手 10-100ms），
// 该响的时候一定响。
const slowBeanThresholdMs = 5;

// 返回 0 或 1 节，让调用方直接 spread——生成的 bootstrap 因此不需要分支。没有慢 bean 的应用
// 摘要里就没有这一节，那是正确输出而不是静默降级。
export function beanTimingSections(
  timings: readonly BeanTimingRecord[],
  loggerName: string,
): readonly StartupSummarySection[] {
  const slow = timings.filter((timing) => timing.ms >= slowBeanThresholdMs);
  const slowest = slowestOf(slow);
  if (slowest === undefined) {
    return [];
  }
  return [
    {
      label: "slow beans",
      // 只点名最慢那一条，其余只给计数（不变量 4：折叠必带计数与出口）。不做「最慢 N 条」：
      // N 是个没人要过的旋钮，而且这一节是摘要里的一整行，facts 从不换行也不截断，
      // 第二个完整 bean id 就撑破 80 列了。
      facts: [`${slow.length} over ${slowBeanThresholdMs}ms`, `${slowest.id} ${slowest.ms}ms`],
      // 出口是调级别，不是 `reforce explain <名词>`：CLI 只读生成物，它算不出运行期耗时。
      // 事实里给的是完整 bean id，读者可以原样贴进 `reforce explain <id>`。调级走显式配置
      //（RFC 0011 L5 勘误）：LoggingSettings.levels 是级别的唯一真相，没有 env 通道。
      expandWith: `LoggingSettings.levels: { "${loggerName}": "debug" }`,
    },
  ];
}

// 并列时按 id 定序，免得同样的启动跑两遍点名不同的 bean。
function slowestOf(timings: readonly BeanTimingRecord[]): BeanTimingRecord | undefined {
  return timings.reduce<BeanTimingRecord | undefined>((best, timing) => {
    if (best === undefined || timing.ms > best.ms) {
      return timing;
    }
    return timing.ms === best.ms && timing.id < best.id ? timing : best;
  }, undefined);
}

export interface ContextStartupFacts {
  /** 生成物已知的 bean 条数。 */
  readonly beanCount: number;
  /** 容器 start 的耗时，毫秒。 */
  readonly contextMs: number;
}

// context 段（RFC 0011 L6【已定】：容器面的事实归 reforce.core）。此前它住在
// @reforce/web-core 的 webStartupSections 里，于是没有引擎的应用连「装了多少 bean、起了多久」
// 都看不到——而那恰恰与 web 无关。
//
// 出口用调级别而不是 `reforce explain beans`：后者跑不通（explain 只认 bean id 与以 / 开头
// 的路由查询），而逐 bean 明细本来就是把这一节展开的东西。
export function contextStartupSections(
  facts: ContextStartupFacts,
  loggerName: string,
): readonly StartupSummarySection[] {
  return [
    {
      label: "context",
      facts: [`${facts.beanCount} beans`, `${facts.contextMs}ms`],
      expandWith: `LoggingSettings.levels: { "${loggerName}": "debug" }`,
    },
  ];
}

export function emitBeanTimings(options: {
  readonly logger: BeanTimingLogger;
  readonly timings: readonly BeanTimingRecord[];
}): void {
  // 不变量 8：级别判定在字段构造之前。台账可能有几百条，逐条建对象再让 logger 丢掉是纯浪费。
  if (!options.logger.isEnabled("debug")) {
    return;
  }
  for (const timing of options.timings) {
    options.logger.debug({ bean: timing.id, phase: timing.phase, ms: timing.ms }, "bean timing");
  }
}
