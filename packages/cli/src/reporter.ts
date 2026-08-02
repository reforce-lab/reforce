import type { Writable } from "node:stream";
import type { CompilerDiagnostic, CompilerDiagnosticCode } from "@reforce/compiler";
import { ReforceRuntimeError, type RuntimeErrorCode } from "@reforce/context";
import { isObject } from "radashi";

export type CliCommandName = "cli" | "dev" | "build" | "start";

export type CliFailurePhase =
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

export interface CliStatusEvent {
  readonly kind: "status";
  readonly command: CliCommandName;
  readonly phase: CliFailurePhase;
  readonly message: string;
}

export interface CliDiagnosticEvent {
  readonly kind: "diagnostic";
  readonly command: "dev" | "build";
  readonly phase: "project" | "compiler";
  readonly diagnostic: CompilerDiagnostic;
}

export interface CliSuccessEvent {
  readonly kind: "success";
  readonly command: CliCommandName;
  readonly message: string;
}

export interface CliFailureEvent {
  readonly kind: "failure";
  readonly command: CliCommandName;
  readonly phase: CliFailurePhase;
  readonly message: string;
  readonly cause: unknown;
  readonly code: CliFailureCode | CompilerDiagnosticCode | RuntimeErrorCode;
  readonly sourceSpan?: CompilerDiagnostic["sourceSpan"];
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

type FailureSourceSpan = NonNullable<CompilerDiagnostic["sourceSpan"]>;
type FailureSourcePosition = FailureSourceSpan["start"];

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
  return isCompilerFailureCause(cause);
}

function isSourcePosition(value: unknown): value is FailureSourcePosition {
  if (!isObject(value)) {
    return false;
  }
  const offset = Reflect.get(value, "offset");
  const line = Reflect.get(value, "line");
  const character = Reflect.get(value, "character");
  return (
    typeof offset === "number" &&
    Number.isInteger(offset) &&
    offset >= 0 &&
    typeof line === "number" &&
    Number.isInteger(line) &&
    line >= 0 &&
    typeof character === "number" &&
    Number.isInteger(character) &&
    character >= 0
  );
}

function isCanonicalFileId(value: unknown): value is FailureSourceSpan["fileId"] {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isSourceSpan(value: unknown): value is FailureSourceSpan {
  if (!isObject(value)) {
    return false;
  }
  const fileId = Reflect.get(value, "fileId");
  const start = Reflect.get(value, "start");
  const end = Reflect.get(value, "end");
  return (
    isCanonicalFileId(fileId) &&
    isSourcePosition(start) &&
    isSourcePosition(end) &&
    end.offset >= start.offset
  );
}

function resolveFailureDetails(cause: unknown): {
  readonly code?: CliFailureEvent["code"];
  readonly sourceSpan?: FailureSourceSpan;
} {
  if (!(cause instanceof ReforceRuntimeError) && !isCompilerFailureCause(cause)) {
    return {};
  }
  const code = Reflect.get(cause, "code");
  const sourceSpan = Reflect.get(cause, "sourceSpan");
  return {
    ...(isCauseFailureCode(cause, code) ? { code } : {}),
    ...(isSourceSpan(sourceSpan) ? { sourceSpan } : {}),
  };
}

export function createFailureEvent(input: {
  readonly command: CliCommandName;
  readonly phase: CliFailurePhase;
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
    ...(details.sourceSpan === undefined ? {} : { sourceSpan: details.sourceSpan }),
  };
}

export async function reportShutdownFailure(input: {
  readonly reporter: Reporter;
  readonly command: CliCommandName;
  readonly errors: readonly unknown[];
}): Promise<void> {
  const cause =
    input.errors.length === 1
      ? input.errors[0]
      : new AggregateError(input.errors, `${input.command} command shutdown failed.`, {
          cause: input.errors[0],
        });
  input.reporter.report(
    createFailureEvent({
      command: input.command,
      phase: "shutdown",
      fallbackCode: "SHUTDOWN_FAILED",
      message: `${input.command} command shutdown failed.`,
      cause,
    }),
  );
  try {
    await input.reporter.flush();
  } catch {}
}

export interface PlainTextReporterOptions {
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

  constructor(options: PlainTextReporterOptions = {}) {
    this.output = options.output ?? process.stderr;
  }

  report(event: CliReporterEvent): void {
    const line = `${renderEvent(event)}\n`;
    this.pending = this.pending.then(
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
    );
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}
