import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Writable } from "node:stream";
import type { RenderMode } from "@reforce/primitives/render-mode";
import { style, type TextStyle } from "@reforce/primitives/terminal";
import type { ReportedDiagnostic, ReportedSpan } from "@/reporter";

// 诊断渲染（RFC 0011 D3，#242）。三模各自有确定的消费者，不能互相靠拢：
//   short —— 逐字保持 #191 以来的 `[CODE] file:LINE:CHAR message` 单行，按行 grep 的脚本与
//            既有断言都钉在这个形状上，任何空白变化都是破坏性改动。
//   human —— 主 span + 源码切片 + caret + related + help，只在人看的终端出现。
//   json  —— 一行一条，字段即 ReportedDiagnostic 全集加一个 kind，给日志聚合。
//
// 类型侧对 @/reporter 是 import type，构建后完全擦除，所以 reporter → diagnostic-render 的
// 值依赖不构成运行时循环。

export interface DiagnosticRenderOptions {
  /** 解析 sourceSpan.fileId 用的项目根；缺席即没有源码切片，只打位置行。 */
  readonly sourceRoot?: string;
  /** 传给 styleText 判断上不上色的目标流，必须是真正要写进去的那个流。 */
  readonly stream: Writable;
  /** CLI 侧确认该诊断码有长文时给出的命令串，例如 `reforce explain MISSING_BEAN`。 */
  readonly explainCommand?: string;
}

type Severity = ReportedDiagnostic["severity"];

// 封闭映射：styleText 对未知格式抛错，级别是唯一的取色输入，穷举在类型上成立。
const severityStyles = {
  error: ["bold", "red"],
  warning: ["bold", "yellow"],
} as const satisfies Record<Severity, readonly TextStyle[]>;

function positionOf(span: ReportedSpan): string {
  return `${span.fileId}:${span.start.line + 1}:${span.start.character + 1}`;
}

export function renderShortDiagnostic(diagnostic: ReportedDiagnostic): string {
  const location = diagnostic.sourceSpan ? ` ${positionOf(diagnostic.sourceSpan)}` : "";
  return `[${diagnostic.code}]${location} ${diagnostic.message}`;
}

function renderJsonDiagnostic(diagnostic: ReportedDiagnostic): string {
  return JSON.stringify({ kind: "diagnostic", ...diagnostic });
}

// 读文件永不抛：诊断已经是失败路径，渲染再失败就什么都看不到了。任何 IO 问题一律当作
// 「没有切片」，降级成只打位置行。
function readSourceLines(sourceRoot: string | undefined, fileId: string): readonly string[] {
  if (sourceRoot === undefined) {
    return [];
  }
  try {
    const path = isAbsolute(fileId) ? fileId : join(sourceRoot, fileId);
    // 行分隔符必须与编译器的 lineStartsOf 完全一致（parser/source-location.ts），否则含
    // U+2028/U+2029 的文件上，切片取到的行与 span 的行号会错开。
    return readFileSync(path, "utf8").split(/\r\n|[\n\r\u2028\u2029]/u);
  } catch {
    return [];
  }
}

// caret 的前导空白由源码前缀逐字符映射而来：非 tab 换成空格、tab 原样保留。这样无论终端把
// tab 展开成几列，caret 都落在正确的列上；直接 " ".repeat(character) 在含 tab 的行上必偏。
function alignmentPrefix(sourceLine: string, character: number): string {
  const prefix = sourceLine.slice(0, Math.min(character, sourceLine.length));
  const padding = " ".repeat(Math.max(0, character - prefix.length));
  return `${prefix.replaceAll(/[^\t]/gu, " ")}${padding}`;
}

function caretWidth(sourceLine: string, span: ReportedSpan): number {
  // 跨行 span 只标到本行结束：多行下划线在终端里读不出边界，rustc 也只标首行。
  const end =
    span.end.line === span.start.line ? span.end.character : Math.max(sourceLine.length, 1);
  return Math.max(1, end - span.start.character);
}

function renderSpanBlock(
  span: ReportedSpan,
  options: DiagnosticRenderOptions,
  severity: Severity,
): readonly string[] {
  const sourceLines = readSourceLines(options.sourceRoot, span.fileId);
  const sourceLine = sourceLines[span.start.line];
  const lineNumber = String(span.start.line + 1);
  const gutter = " ".repeat(lineNumber.length);
  const header = `${gutter}${style(["cyan"], "-->", options.stream)} ${positionOf(span)}`;
  if (sourceLine === undefined) {
    return [header];
  }
  const bar = style(["cyan"], "|", options.stream);
  const caret = style(
    severityStyles[severity],
    "^".repeat(caretWidth(sourceLine, span)),
    options.stream,
  );
  return [
    header,
    `${gutter} ${bar}`,
    `${style(["cyan"], lineNumber, options.stream)} ${bar} ${sourceLine}`,
    `${gutter} ${bar} ${alignmentPrefix(sourceLine, span.start.character)}${caret}`,
  ];
}

function renderNoteLine(label: string, text: string, options: DiagnosticRenderOptions): string {
  return `  ${style(["cyan"], "=", options.stream)} ${style(["bold"], `${label}:`, options.stream)} ${text}`;
}

export function renderHumanDiagnostic(
  diagnostic: ReportedDiagnostic,
  options: DiagnosticRenderOptions,
): string {
  const lines: string[] = [
    `${style(severityStyles[diagnostic.severity], `${diagnostic.severity}[${diagnostic.code}]`, options.stream)}: ${diagnostic.message}`,
  ];
  if (diagnostic.sourceSpan !== undefined) {
    lines.push(...renderSpanBlock(diagnostic.sourceSpan, options, diagnostic.severity));
  }
  for (const related of diagnostic.related) {
    lines.push(renderNoteLine("note", related.message, options));
    if (related.sourceSpan !== undefined) {
      lines.push(`    ${style(["cyan"], "-->", options.stream)} ${positionOf(related.sourceSpan)}`);
    }
  }
  for (const suggestion of diagnostic.suggestions ?? []) {
    // applicability 必须一起打出来：machine-applicable 与 has-placeholders 是两种完全不同的
    // 「照做」，不标出来读者无从判断能不能直接抄。
    lines.push(
      renderNoteLine(
        `suggestion(${suggestion.applicability})`,
        `${suggestion.message} → ${suggestion.replacement}`,
        options,
      ),
    );
  }
  if (diagnostic.help !== undefined) {
    lines.push(renderNoteLine("help", diagnostic.help, options));
  }
  if (options.explainCommand !== undefined) {
    lines.push(renderNoteLine("详解", options.explainCommand, options));
  }
  return lines.join("\n");
}

export function renderDiagnostic(
  diagnostic: ReportedDiagnostic,
  mode: RenderMode,
  options: DiagnosticRenderOptions,
): string {
  switch (mode) {
    case "short":
      return renderShortDiagnostic(diagnostic);
    case "json":
      return renderJsonDiagnostic(diagnostic);
    case "human":
      return renderHumanDiagnostic(diagnostic, options);
  }
}
