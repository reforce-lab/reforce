import type { Writable } from "node:stream";
import { foldStackFrames } from "@reforce/runtime/stack-frames";
import { padEnd, padStart, style, type TextStyle, truncateStart } from "@reforce/runtime/terminal";
import type { LogLevel, LogRecord } from "@/contracts";

// 应用日志的 human 档（RFC 0011 D1/D2，#242）：dev TTY 下给人扫一眼的对齐行，管道与生产
// 照旧 JSON——同一份事件两种渲染，字段不因模式增减（不变量 3）。
//
// 住在自己的文件里而不是跟着 render-record：那边被引导缓冲的 drain 消费，绕进
// 缓冲 → 默认绑定 → 级别绑定 → 引导注册表 → 缓冲 的 import 环；这边只被默认绑定消费，
// 不进环。

// 级别 → 颜色是封闭映射，与启动摘要同一张表：styleText 对未知格式抛 ERR_INVALID_ARG_VALUE，
// 不静默降级。颜色不是级别的唯一通道——级别词本身在，NO_COLOR/管道/色盲下信息不丢（D2）。
const levelStyles = {
  trace: ["dim"],
  debug: ["dim"],
  info: ["cyan"],
  warn: ["bold", "yellow"],
  error: ["bold", "red"],
  fatal: ["bold", "red"],
} as const satisfies Record<LogLevel, readonly TextStyle[]>;

// 级别词右对齐（"  info" / " error"）：长短不一的词靠右对齐后，名字列才有一条稳定的左缘。
const levelWidth = 6;
// logger 名右对齐截断（truncateStart）：区分度在尾段，砍头保尾读起来仍认得出是谁。
const nameWidth = 18;

export interface HumanRenderOptions {
  /** 颜色按这条流判定（styleText 读它的 TTY 状态与 NO_COLOR）。 */
  readonly stream: Writable;
  /** 栈帧折叠的展开开关（D6）；缺省折叠 node/reforce 帧。 */
  readonly verbose?: boolean;
}

function formatFieldValue(value: unknown): string {
  if (typeof value === "string") {
    return /[\s"=]/u.test(value) ? JSON.stringify(value) : value;
  }
  return JSON.stringify(value) ?? String(value);
}

function formatFields(fields: LogRecord["fields"]): string {
  return Object.entries(fields)
    .filter(([key]) => key !== "err")
    .map(([key, value]) => `${key}=${formatFieldValue(value)}`)
    .join(" ");
}

function causeChainOf(error: Error): readonly Error[] {
  const chain: Error[] = [];
  let current: unknown = error.cause;
  // 环与超长链都可能来自用户数据：封顶而不是信任它有限。
  while (current instanceof Error && chain.length < 8 && !chain.includes(current)) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

// 竖排的 cause 链（D6）：每层一行 `└ caused by`，根因是最值得看的那一层，高亮它而不是最外层
// ——最外层通常只是「谁把它包了一下」。
function renderError(error: Error, options: HumanRenderOptions): readonly string[] {
  const indent = " ".repeat(levelWidth + 1);
  const stack =
    typeof error.stack === "string" ? foldStackFrames(error.stack, options.verbose ?? false) : "";
  const stackLines =
    stack.length === 0
      ? [`${error.name}: ${error.message}`]
      : stack.split("\n").map((line) => line.trimEnd());
  const causes = causeChainOf(error);
  const causeLines = causes.map((cause, index) => {
    const isRoot = index === causes.length - 1;
    const label = `${cause.name}: ${cause.message}`;
    return `└ caused by  ${isRoot ? style(["bold", "red"], label, options.stream) : label}`;
  });
  return [...stackLines, ...causeLines].map((line) => `${indent}${line}`);
}

/**
 * 有状态的 human 渲染器：相对时间戳（`+12ms`）是与上一条记录的间隔——dev TTY 下读者关心的
 * 是「这两步之间过了多久」，完整时刻表归 JSON 模式（那边 epoch 与 ISO 都在）。
 */
export function createHumanRenderer(options: HumanRenderOptions): (record: LogRecord) => string {
  let lastTime: number | undefined;
  return (record) => {
    const sinceMs = lastTime === undefined ? 0 : Math.max(0, record.time - lastTime);
    lastTime = record.time;
    const level = style(
      levelStyles[record.level],
      padStart(record.level, levelWidth),
      options.stream,
    );
    const name = padEnd(truncateStart(record.name, nameWidth), nameWidth);
    const fields = formatFields(record.fields);
    const elapsed = style(["dim"], `+${sinceMs}ms`, options.stream);
    const head = [
      `${level} ${name} ${record.message}`,
      ...(fields.length === 0 ? [] : [style(["dim"], fields, options.stream)]),
      elapsed,
    ].join("  ");
    const err = record.fields.err;
    if (err instanceof Error) {
      return [head, ...renderError(err, options)].join("\n");
    }
    return head;
  };
}
