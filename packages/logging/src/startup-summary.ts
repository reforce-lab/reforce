import type { Writable } from "node:stream";
import { columnsOf, isInteractive, padEnd, style, truncateStart } from "@reforce/runtime/terminal";
import type { LogLevel } from "@/contracts";

// 启动摘要（RFC 0011 D2，#242）：把「这个应用装配成了什么」压成几行，而不是逐条 bean 刷屏。
//
// **不复用 explain 的原语**：`cli/src/explain/render.ts` 明写「无对齐留白，供人读也供脚本
// grep」，且 `test/explain/routes.spec.ts` 有逐行断言。启动摘要要的恰恰相反——它是给人扫一眼
// 的，需要对齐。两者显式分家，各写各的（勘误第 10 条）。
//
// 折叠必带计数与展开命令：`4 controllers · 37 routes` 后面明写 `reforce explain routes`。
// 只折叠不给出口，读者就只能去翻源码——那等于把信息藏起来还假装简洁了。

export interface StartupSummarySection {
  readonly label: string;
  /** 折叠后的一行事实，用 " · " 分隔，与 explain 的字段分隔符一致（那是给人读的习惯，不是契约）。 */
  readonly facts: readonly string[];
  /** 展开这一节的命令；没有出口的折叠不允许存在。 */
  readonly expandWith?: string;
}

export interface StartupSummary {
  readonly sections: readonly StartupSummarySection[];
  /** 应用完成装配的时刻，epoch 毫秒。 */
  readonly readyAt: number;
  /** 进程启动时刻，用来算相对时间。 */
  readonly startedAt: number;
}

export interface StartupSummaryRenderOptions {
  readonly stream: Writable;
  /** 人读模式打相对时间（`+12ms`），结构化模式打完整 ISO。 */
  readonly mode: "human" | "json";
  readonly level?: LogLevel;
  /** 覆盖终端宽度，仅测试用；缺省从 stream 读。 */
  readonly columns?: number;
}

// 级别 → 颜色是封闭映射：styleText 对未知格式抛 ERR_INVALID_ARG_VALUE、不静默降级。
const levelStyles = {
  trace: ["dim"],
  debug: ["dim"],
  info: ["cyan"],
  warn: ["bold", "yellow"],
  error: ["bold", "red"],
  fatal: ["bold", "red"],
} as const satisfies Record<LogLevel, readonly ("dim" | "cyan" | "bold" | "yellow" | "red")[]>;

// 标签列宽的上限。终端窄到放不下时按可用宽度收，但不低于这个数——再窄下去标签就只剩省略号，
// 那还不如不对齐。
const maximumLabelWidth = 14;
const minimumLabelWidth = 6;

function labelWidth(
  sections: readonly StartupSummarySection[],
  columns: number | undefined,
): number {
  const longest = Math.max(0, ...sections.map((section) => section.label.length));
  const budget = columns === undefined ? maximumLabelWidth : Math.floor(columns / 3);
  return Math.max(
    minimumLabelWidth,
    Math.min(longest, maximumLabelWidth, Math.max(budget, minimumLabelWidth)),
  );
}

// 颜色不得是级别的唯一通道：级别词本身必须在。管道里、NO_COLOR 下、色盲用户那里，颜色都
// 可能不存在，而「这是不是一条 warn」不能因此丢失。
function renderLevel(level: LogLevel, options: StartupSummaryRenderOptions): string {
  return style(levelStyles[level], level, options.stream);
}

// 摘要要的最小 logger 形状，由消费侧定义（同 web 的 RequestLogger）：这样 @reforce/web 的
// bootstrap 把它的 logger 传进来时不必先认识本包的 Logger 类型。
export interface StartupSummaryLogger {
  info(fields: Readonly<Record<string, unknown>> | undefined, message: string): void;
}

export interface EmitStartupSummaryOptions {
  readonly summary: StartupSummary;
  /** 结构化去处（L6：运行期框架输出走 Logger）。缺席时只剩人读那条路。 */
  readonly logger?: StartupSummaryLogger;
  /** 人读去处，缺省 stderr；是 TTY 时摘要按对齐的 human 形态直接落在这里。 */
  readonly stream?: Writable;
  /** 覆盖 TTY 判定，仅测试用。 */
  readonly interactive?: boolean;
}

// D2 的生产者（#242）。此前 renderStartupSummary 是零消费者的——渲染器有了，没人生产。
//
// 两条去处按「人正盯着这次启动吗」二选一，不是两条都发：
//   - TTY：按对齐的 human 形态落 stream。这一刻读者要的是扫一眼就看懂，一行 JSON 不合格。
//   - 非 TTY（管道、容器、CI）：走 Logger 发结构化记录，进用户配置的格式与目标。
// 两边都发会让 `reforce start | tee` 里同一份摘要出现两次。
export function emitStartupSummary(options: EmitStartupSummaryOptions): void {
  const stream = options.stream ?? process.stderr;
  const interactive = options.interactive ?? isInteractive(stream);
  if (!interactive && options.logger !== undefined) {
    for (const section of options.summary.sections) {
      options.logger.info(
        {
          facts: section.facts,
          ...(section.expandWith === undefined ? {} : { expandWith: section.expandWith }),
        },
        section.label,
      );
    }
    options.logger.info(
      { startupMs: Math.max(0, options.summary.readyAt - options.summary.startedAt) },
      "ready",
    );
    return;
  }
  for (const line of renderStartupSummary(options.summary, {
    stream,
    mode: interactive ? "human" : "json",
  })) {
    stream.write(`${line}\n`);
  }
}

export function renderStartupSummary(
  summary: StartupSummary,
  options: StartupSummaryRenderOptions,
): readonly string[] {
  const level = options.level ?? "info";
  if (options.mode === "json") {
    // 结构化模式打完整 ISO：相对时间只在「人正盯着这次启动」时有意义，进了日志系统之后
    // 「+12ms」相对于什么已经无从得知。
    return summary.sections.map((section) =>
      JSON.stringify({
        level,
        name: "reforce.startup",
        time: summary.readyAt,
        timestamp: new Date(summary.readyAt).toISOString(),
        message: section.label,
        facts: section.facts,
        ...(section.expandWith === undefined ? {} : { expandWith: section.expandWith }),
      }),
    );
  }
  const columns = options.columns ?? columnsOf(options.stream);
  const width = labelWidth(summary.sections, columns);
  const elapsed = `+${Math.max(0, summary.readyAt - summary.startedAt)}ms`;
  const lines = summary.sections.map((section) => {
    // 名字右对齐截断：区分度在尾段，砍头保尾读起来仍认得出是谁。
    const label = padEnd(truncateStart(section.label, width), width);
    const facts = section.facts.join(" · ");
    const expand =
      section.expandWith === undefined
        ? ""
        : ` ${style(["dim"], `— ${section.expandWith}`, options.stream)}`;
    return `${renderLevel(level, options)} ${style(["bold"], label, options.stream)} ${facts}${expand}`;
  });
  return [...lines, `${renderLevel(level, options)} ${padEnd("ready", width)} ${elapsed}`];
}
