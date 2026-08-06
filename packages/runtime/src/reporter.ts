import type { Writable } from "node:stream";
import { ReforceRuntimeError } from "@reforce/context";
import { isObject } from "radashi";
import { renderDiagnostic } from "@/diagnostic-render";
import { type RenderAudience, type RenderMode, resolveRenderMode } from "@/render-mode";
import { isInteractive, style } from "@/terminal";

export type CliCommandName = "cli" | "dev" | "build" | "start" | "lib" | "explain";

export type CliCommandPhase =
  | "argv"
  | "project"
  | "compiler"
  | "generated-commit"
  | "dist-commit"
  | "build"
  | "bootstrap"
  | "hmr"
  | "child"
  | "shutdown"
  // 崩溃是独立阶段：它既不是 bootstrap 也不是 shutdown，混进任一个都会让按 phase 过滤的
  // 消费者读错现场（RFC 0011 C2，#250）。
  | "crash";

export type CliFailureCode =
  | "CLI_USAGE_ERROR"
  | "PACKAGE_EXPORTS_INVALID"
  | "PROJECT_BUSY"
  | "GENERATED_TRANSACTION_FAILED"
  | "DIST_TRANSACTION_FAILED"
  | "BUILD_FAILED"
  | "ARTIFACT_INVALID"
  | "BOOTSTRAP_FAILED"
  | "HMR_FATAL"
  | "CHILD_FAILED"
  | "SHUTDOWN_FAILED"
  | "UNCAUGHT_EXCEPTION";

interface CliStatusEvent {
  readonly kind: "status";
  readonly command: CliCommandName;
  readonly phase: CliCommandPhase;
  readonly message: string;
}

// 诊断 wire shape 由 reporter 侧定义（ADR 0009，#191）：渲染只消费本接口列出的字段，
// reporter 因此不依赖上游分析器——这是把 reporter 随运行时拆出 cli 的前置。
// 上游诊断结构性满足本接口，对齐锚点见 cli 的 compiler-types.ts。
export interface ReportedSpan {
  readonly fileId: string;
  readonly start: { readonly line: number; readonly character: number };
  // end 是 human 模式画 caret 下划线的唯一来源（RFC 0011 D3，#242）：没有它只能在起点打一个
  // `^`，标不出「问题横跨哪一段」。
  readonly end: { readonly line: number; readonly character: number };
}

export interface ReportedDiagnostic {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly sourceSpan?: ReportedSpan;
  readonly related: readonly {
    readonly message: string;
    readonly sourceSpan?: ReportedSpan;
  }[];
  readonly help?: string;
  // 机器可读的修复建议（RFC 0011 D4，#242）：json 原样输出，human 渲染成一行 note。
  // 只渲染，不应用——改写用户源码是另一个主题，本波不做 `reforce fix`。
  readonly suggestions?: readonly {
    readonly message: string;
    readonly span: ReportedSpan;
    readonly replacement: string;
    readonly applicability: "machine-applicable" | "maybe-incorrect" | "has-placeholders";
  }[];
}

interface CliDiagnosticEvent {
  readonly kind: "diagnostic";
  readonly command: "dev" | "build" | "lib";
  readonly phase: "project" | "compiler";
  readonly diagnostic: ReportedDiagnostic;
  // 该诊断码有长文时由 CLI 填入完整命令串（`reforce explain <CODE>`）。渲染器只判断有没有，
  // 不认识 CLI 的长文表——反过来会让 runtime 依赖 cli 的语汇（RFC 0011 D8，#242）。
  readonly explainCommand?: string;
}

interface CliSuccessEvent {
  readonly kind: "success";
  readonly command: CliCommandName;
  readonly message: string;
}

interface CliFailureEvent {
  readonly kind: "failure";
  readonly command: CliCommandName;
  readonly phase: CliCommandPhase;
  readonly message: string;
  readonly cause: unknown;
  // 值域是 CliFailureCode ∪ compiler 诊断码 ∪ RuntimeErrorCode；后两者的语汇属各自的包，
  // reporter 只原样透传，类型如实坍缩为 string（ADR 0009）。构造点仍然静态成立：fallbackCode
  // 收 CliFailureCode，ReforceRuntimeError.code 收 RuntimeErrorCode。
  readonly code: string;
}

export type CliReporterEvent =
  | CliStatusEvent
  | CliDiagnosticEvent
  | CliSuccessEvent
  | CliFailureEvent;

export interface Reporter {
  report(event: CliReporterEvent): void;
  flush(): Promise<void>;
}

// 不再看 severity（RFC 0011 OM2，#242）：诊断有了 warning 之后，把 severity === "error" 写进
// 判别式会让一条 warning 当 cause 时落回 fallbackCode，丢掉它自己的码。kind === "compiler"
// 加上形态校验已经足够判别。
function isCompilerFailureCause(value: unknown): value is object {
  return (
    isObject(value) &&
    Reflect.get(value, "kind") === "compiler" &&
    typeof Reflect.get(value, "message") === "string" &&
    Array.isArray(Reflect.get(value, "related"))
  );
}

// 只校验形态（非空白字符串）、不做成员校验：诊断码语汇属 compiler 包，这里没有（也不该有）
// 运行时成员列表可穷举，只能信任 wire 上的 code 原样透传。改成严格校验会把未列出的 code 打成
// fallback，属行为变更。
function isReportedDiagnosticCode(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveFailureCode(cause: unknown): CliFailureEvent["code"] | undefined {
  if (cause instanceof ReforceRuntimeError) {
    return cause.code;
  }
  if (!isCompilerFailureCause(cause)) {
    return undefined;
  }
  const code = Reflect.get(cause, "code");
  return isReportedDiagnosticCode(code) ? code : undefined;
}

export function createFailureEvent(input: {
  readonly command: CliCommandName;
  readonly phase: CliCommandPhase;
  readonly fallbackCode: CliFailureCode;
  readonly message: string;
  readonly cause: unknown;
}): CliFailureEvent {
  return {
    kind: "failure",
    command: input.command,
    phase: input.phase,
    code: resolveFailureCode(input.cause) ?? input.fallbackCode,
    message: input.message,
    cause: input.cause,
  };
}

// 关停步骤必须全部跑完：前一步抛错不能跳过后面的释放动作，所以错误先攒进数组，最后交给
// reportShutdownFailure 聚合。数组是 unknown[] 而不是 Error[]——throw 的值不保证是 Error，
// 换成 Error[] 等于在没有校验的情况下收窄类型。
export async function captureFailure(
  operation: () => Promise<void>,
  failures: unknown[],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
}

export async function reportShutdownFailure(input: {
  readonly reporter: Reporter;
  readonly command: CliCommandName;
  readonly errors: readonly unknown[];
}): Promise<void> {
  const message = `${input.command} command shutdown failed.`;
  const cause =
    input.errors.length === 1
      ? input.errors[0]
      : new AggregateError(input.errors, message, {
          cause: input.errors[0],
        });
  input.reporter.report(
    createFailureEvent({
      command: input.command,
      phase: "shutdown",
      fallbackCode: "SHUTDOWN_FAILED",
      message,
      cause,
    }),
  );
  try {
    await input.reporter.flush();
  } catch {}
}

export interface PlainTextReporterOptions {
  readonly output?: Writable;
  /** 显式模式（`--error-format`）；缺席时按 audience/TTY/env 解析一次并定死。 */
  readonly mode?: RenderMode;
  readonly audience?: RenderAudience;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** human 模式解析诊断 fileId 用的项目根；缺席即无源码切片。 */
  readonly sourceRoot?: string;
}

const maximumCauseDepth = 5;

function nextCause(value: unknown): unknown {
  // radashi 的 isObject 只认 plain object，Error 实例必须单独取 cause。
  if (value instanceof Error) {
    return value.cause;
  }
  return isObject(value) ? Reflect.get(value, "cause") : undefined;
}

// 折叠空白：short 模式的契约是一个事件恰好占一行，否则按行读 stderr 的人和断言都会被换行
// 切断。human/json 各有自己的分行规则，不走这里。
function toSingleLine(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

function describeCause(value: unknown): string | undefined {
  if (typeof value === "string") {
    return toSingleLine(value);
  }
  if (value instanceof Error) {
    return toSingleLine(value.message);
  }
  if (!isObject(value)) {
    return undefined;
  }
  const message = Reflect.get(value, "message");
  return typeof message === "string" ? toSingleLine(message) : undefined;
}

// 失败必须自我描述：CI 上往往只剩这一行 stderr，丢掉 cause 就无法区分同一个 code 底下的
// 不同失败原因（Issue #32）。重复文案只出现一次——包装层常把同一句话既当 message 又当 cause。
// 段序即包装序：[0] 是最外层，末位是最深的根因。
function failureSegments(event: CliFailureEvent): readonly string[] {
  const segments = [event.message];
  const rendered = new Set(segments);
  let cause = event.cause;
  for (let depth = 0; depth < maximumCauseDepth && cause !== undefined; depth += 1) {
    const description = describeCause(cause);
    if (description !== undefined && description.length > 0 && !rendered.has(description)) {
      rendered.add(description);
      segments.push(description);
    }
    cause = nextCause(cause);
  }
  return segments;
}

// 运行期错误与编译期诊断同框（RFC 0011 D5，#242）：help 挂在 ReforceRuntimeError 上，但抛出点
// 常被包装若干层，所以整条 cause 链上取第一条 help。
function failureHelp(event: CliFailureEvent): string | undefined {
  let cause = event.cause;
  for (let depth = 0; depth < maximumCauseDepth && cause !== undefined; depth += 1) {
    if (cause instanceof ReforceRuntimeError && cause.help !== undefined) {
      return cause.help;
    }
    cause = nextCause(cause);
  }
  return undefined;
}

interface RenderContext {
  readonly mode: RenderMode;
  readonly output: Writable;
  readonly sourceRoot?: string;
}

function renderHumanFailure(event: CliFailureEvent, context: RenderContext): string {
  const segments = failureSegments(event);
  const [headline, ...causes] = segments;
  const lines = [
    `${style(["bold", "red"], `error[${event.code}]`, context.output)}: ${headline ?? event.message}`,
  ];
  // 竖排而不是 `a <- b <- c`：JS 的根因在链条最深处，横排时它被挤到行尾最容易被忽略。
  // 最后一段就是根因，单独高亮。
  causes.forEach((cause, index) => {
    const isRootCause = index === causes.length - 1;
    const text = isRootCause ? style(["bold"], cause, context.output) : cause;
    lines.push(`  ${style(["cyan"], "caused by", context.output)}: ${text}`);
  });
  const help = failureHelp(event);
  if (help !== undefined) {
    lines.push(
      `  ${style(["cyan"], "=", context.output)} ${style(["bold"], "help:", context.output)} ${help}`,
    );
  }
  return lines.join("\n");
}

// 诊断的 JSON 形状住在 diagnostic-render（就是 ReportedDiagnostic 全集加一个 kind），这里只管
// 其余三种事件，避免同一个 wire 形状写在两处。
function renderJsonEvent(event: Exclude<CliReporterEvent, CliDiagnosticEvent>): string {
  switch (event.kind) {
    case "status":
      return JSON.stringify({
        kind: "status",
        command: event.command,
        phase: event.phase,
        message: event.message,
      });
    case "success":
      return JSON.stringify({ kind: "success", command: event.command, message: event.message });
    case "failure": {
      // cause 本身不进 JSON：它是 unknown，可能带循环引用或不可序列化成员，JSON.stringify 会
      // 抛在失败上报这条最不能再失败的路径上。已归一成字符串的 causes 是等价且安全的替代。
      const [, ...causes] = failureSegments(event);
      const help = failureHelp(event);
      return JSON.stringify({
        kind: "failure",
        command: event.command,
        phase: event.phase,
        code: event.code,
        message: event.message,
        causes,
        ...(help === undefined ? {} : { help }),
      });
    }
  }
}

function renderEvent(event: CliReporterEvent, context: RenderContext): string {
  if (event.kind === "diagnostic") {
    return renderDiagnostic(event.diagnostic, context.mode, {
      stream: context.output,
      ...(context.sourceRoot === undefined ? {} : { sourceRoot: context.sourceRoot }),
      ...(event.explainCommand === undefined ? {} : { explainCommand: event.explainCommand }),
    });
  }
  if (context.mode === "json") {
    return renderJsonEvent(event);
  }
  switch (event.kind) {
    case "status":
      return `[${event.command}:${event.phase}] ${event.message}`;
    case "success":
      return `[${event.command}] ${event.message}`;
    case "failure":
      return context.mode === "human"
        ? renderHumanFailure(event, context)
        : `[${event.code}] ${failureSegments(event).join(" <- ")}`;
  }
}

export class PlainTextReporter implements Reporter {
  private readonly output: Writable;
  private readonly context: RenderContext;
  private pending = Promise.resolve();
  private firstWriteFailure: unknown;

  constructor(options: PlainTextReporterOptions = {}) {
    this.output = options.output ?? process.stderr;
    // 模式在构造时解析一次并定死：同一次运行里换模式会让上下两半输出对不上，按行读的
    // 消费者无从判断该用哪套解析。
    this.context = {
      mode: resolveRenderMode({
        ...(options.mode === undefined ? {} : { explicit: options.mode }),
        interactive: isInteractive(this.output),
        audience: options.audience ?? "tool",
        env: options.env ?? process.env,
      }),
      output: this.output,
      ...(options.sourceRoot === undefined ? {} : { sourceRoot: options.sourceRoot }),
    };
  }

  get renderMode(): RenderMode {
    return this.context.mode;
  }

  report(event: CliReporterEvent): void {
    const line = `${renderEvent(event, this.context)}\n`;
    // 一次写失败不能让 reporter 余生失效：链上不挂 catch 时 pending 会永久 rejected，
    // 之后每个 report 都被静默丢弃，Node 对这些无 handler 的 rejection 默认按 unhandledRejection 崩进程
    // （命令本身成功也退出 1）。这里把失败降级为「记录首个错误、继续排队」，首个错误
    // 由 flush() 交回调用方；catch 挂在链尾也顺带兜住 write 的同步抛出（#25）。
    this.pending = this.pending
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            this.output.write(line, (error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      )
      .catch((error: unknown) => {
        this.firstWriteFailure ??= error;
      });
  }

  async flush(): Promise<void> {
    await this.pending;
    // 记录的错误刻意是粘的：后续写成功不代表先前丢掉的输出补回来了，flush 不能改口说成功。
    if (this.firstWriteFailure !== undefined) {
      throw this.firstWriteFailure;
    }
  }
}
