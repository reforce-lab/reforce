import type { Writable } from "node:stream";
import { styleText } from "node:util";

// 终端原语（RFC 0011 D2/D3，#242）：本仓第一处颜色与宽度计算，只包 node:util，零依赖——
// @reforce/runtime 的依赖表只允许 @reforce/context / @swc/helpers / radashi。

// 封闭字面量而不是 string：styleText 对未知格式抛 ERR_INVALID_ARG_VALUE，不静默降级，
// 所以「级别 → 颜色」的映射必须在类型上就穷举完（Node 26.5.1 实测）。
export type TextStyle =
  | "bold"
  | "dim"
  | "italic"
  | "underline"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "gray";

// 恒传 {stream}：styleText 的缺省流是 process.stdout，写 stderr 时不传就会按 stdout 的
// TTY 状态判断上不上色——stdout 重定向到文件、stderr 仍是终端时会整个判反。
// validateStream 保持缺省 true：设成 false 连 NO_COLOR 都不再尊重。
export function style(formats: readonly TextStyle[], text: string, stream: Writable): string {
  return styleText([...formats], text, { stream });
}

// isTTY 不在 Writable 的声明里（只有 tty.WriteStream 有），所以必须运行时读：写死成
// process.stderr 会在测试注入 sink 或输出被重定向时判反。
export function isInteractive(stream: Writable): boolean {
  return Reflect.get(stream, "isTTY") === true;
}

// 两个退化值必须一起归一：伪 tty（script/pty）下 columns 是 0，非 TTY 下是 undefined，
// 只判 undefined 会让宽度 0 一路传到截断函数，把每一行都截成空串。
export function columnsOf(stream: Writable): number | undefined {
  const columns = Reflect.get(stream, "columns");
  if (typeof columns !== "number" || !Number.isFinite(columns) || columns <= 0) {
    return undefined;
  }
  return columns;
}

// 右对齐截断：超宽时保留尾部而不是头部。logger 名（`services.orders.OrderService`）的区分度
// 在尾段，砍头保尾读起来仍认得出是谁；砍尾会让同前缀的名字全变成同一个串。
// 宽度按 UTF-16 单元数算，不是显示宽度——本仓没有全角/emoji 的 logger 名，多引一个字宽库
// 不划算；真出现时这里会偏窄而不是偏宽，不会撑破布局。
export function truncateStart(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (text.length <= width) {
    return text;
  }
  if (width === 1) {
    return "…";
  }
  return `…${text.slice(text.length - (width - 1))}`;
}

export function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}
