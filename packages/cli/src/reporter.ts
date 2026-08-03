import type { Writable } from "node:stream";
import type { CompilerDiagnostic, CompilerDiagnosticCode } from "@reforce/compiler";
import { ReforceRuntimeError, type RuntimeErrorCode } from "@reforce/context";
import { isObject } from "radashi";

export type CliCommandName = "cli" | "dev" | "build" | "start";

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

interface CliDiagnosticEvent {
  readonly kind: "diagnostic";
  readonly command: "dev" | "build";
  readonly phase: "project" | "compiler";
  readonly diagnostic: CompilerDiagnostic;
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
  readonly code: CliFailureCode | CompilerDiagnosticCode | RuntimeErrorCode;
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

function isCauseFailureCode(cause: unknown, value: unknown): value is CliFailureEvent["code"] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  if (cause instanceof ReforceRuntimeError) {
    return value === cause.code;
  }
  // compiler 分支只校验形态（非空白字符串）、不做成员校验：compiler 包只导出
  // CompilerDiagnosticCode 类型，没有运行时成员列表可穷举，只能信任 compiler 产出的
  // code 原样透传。改成严格校验会把未列出的 code 打成 fallback，属行为变更。
  return isCompilerFailureCause(cause);
}

function resolveFailureDetails(cause: unknown): {
  readonly code?: CliFailureEvent["code"];
} {
  if (!(cause instanceof ReforceRuntimeError) && !isCompilerFailureCause(cause)) {
    return {};
  }
  const code = Reflect.get(cause, "code");
  return isCauseFailureCode(cause, code) ? { code } : {};
}

export function createFailureEvent(input: {
  readonly command: CliCommandName;
  readonly phase: CliCommandPhase;
  readonly fallbackCode: CliFailureCode;
  readonly message: string;
  readonly cause: unknown;
}): CliFailureEvent {
  const details = resolveFailureDetails(input.cause);
  return {
    kind: "failure",
    command: input.command,
    phase: input.phase,
    code: details.code ?? input.fallbackCode,
    message: input.message,
    cause: input.cause,
  };
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
      return `[${event.code}] ${event.message}`;
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
