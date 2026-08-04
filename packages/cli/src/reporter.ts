import type { Writable } from "node:stream";
import { ReforceRuntimeError } from "@reforce/context";
import { isObject } from "radashi";

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
  | "shutdown";

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
  | "SHUTDOWN_FAILED";

interface CliStatusEvent {
  readonly kind: "status";
  readonly command: CliCommandName;
  readonly phase: CliCommandPhase;
  readonly message: string;
}

// 诊断 wire shape 由 reporter 侧定义（ADR 0009，#191）：渲染只消费 code/message/sourceSpan，
// reporter 因此不依赖 @reforce/compiler——这是把 reporter 随运行时拆出 cli 的前置。
// CompilerDiagnostic 结构性满足本接口，对齐锚点见 compiler-types.ts。
export interface ReportedDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly sourceSpan?: {
    readonly fileId: string;
    readonly start: { readonly line: number; readonly character: number };
  };
}

interface CliDiagnosticEvent {
  readonly kind: "diagnostic";
  readonly command: "dev" | "build" | "lib";
  readonly phase: "project" | "compiler";
  readonly diagnostic: ReportedDiagnostic;
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

function isCompilerFailureCause(value: unknown): value is object {
  return (
    isObject(value) &&
    Reflect.get(value, "kind") === "compiler" &&
    Reflect.get(value, "severity") === "error" &&
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

interface PlainTextReporterOptions {
  readonly output?: Writable;
}

const maximumCauseDepth = 5;

function nextCause(value: unknown): unknown {
  // radashi 的 isObject 只认 plain object，Error 实例必须单独取 cause。
  if (value instanceof Error) {
    return value.cause;
  }
  return isObject(value) ? Reflect.get(value, "cause") : undefined;
}

// 折叠空白：一个事件必须恰好占一行，否则按行读 stderr 的人和断言都会被换行切断。
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
function renderFailure(event: CliFailureEvent): string {
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
  return `[${event.code}] ${segments.join(" <- ")}`;
}

function renderEvent(event: CliReporterEvent): string {
  switch (event.kind) {
    case "status":
      return `[${event.command}:${event.phase}] ${event.message}`;
    case "diagnostic": {
      const { diagnostic } = event;
      const location = diagnostic.sourceSpan
        ? ` ${diagnostic.sourceSpan.fileId}:${diagnostic.sourceSpan.start.line + 1}:${diagnostic.sourceSpan.start.character + 1}`
        : "";
      return `[${diagnostic.code}]${location} ${diagnostic.message}`;
    }
    case "success":
      return `[${event.command}] ${event.message}`;
    case "failure":
      return renderFailure(event);
  }
}

export class PlainTextReporter implements Reporter {
  private readonly output: Writable;
  private pending = Promise.resolve();
  private firstWriteFailure: unknown;

  constructor(options: PlainTextReporterOptions = {}) {
    this.output = options.output ?? process.stderr;
  }

  report(event: CliReporterEvent): void {
    const line = `${renderEvent(event)}\n`;
    // 一次写失败不能让 reporter 余生失效：链上不挂 catch 时 pending 会永久 rejected，
    // 之后每个 report 都被静默丢弃，Bun 还会把这些无 handler 的 rejection 记成进程失败
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
