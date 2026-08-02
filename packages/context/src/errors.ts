import type { ContextOperation, ContextState } from "./public-types";

export type RuntimeErrorCode =
  | "EARLY_BEAN_ACCESS"
  | "BEAN_CREATION_FAILED"
  | "BEAN_LIFECYCLE_FAILED"
  | "BEAN_DISPOSAL_FAILED"
  | "APPLICATION_START_FAILED"
  | "APPLICATION_CLEANUP_FAILED"
  | "UNREGISTERED_BEAN_TARGET"
  | "APPLICATION_CONTEXT_STATE"
  | "INVALID_GENERATED_DEFINITION";

interface RuntimeErrorOptions {
  readonly cause?: unknown;
  readonly errors?: readonly unknown[];
}

export abstract class ReforceRuntimeError<
  Code extends RuntimeErrorCode = RuntimeErrorCode,
> extends Error {
  abstract readonly code: Code;
  override readonly cause?: unknown;
  readonly errors?: readonly unknown[];

  protected constructor(message: string, options: RuntimeErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.cause = options.cause;
    this.errors = options.errors;
  }
}

export class EarlyBeanAccessError extends ReforceRuntimeError<"EARLY_BEAN_ACCESS"> {
  readonly code = "EARLY_BEAN_ACCESS" as const;
  readonly beanId: string;
  readonly constructionPath: readonly string[];

  constructor(input: {
    readonly beanId: string;
    readonly constructionPath: readonly string[];
  }) {
    super(`Bean "${input.beanId}" was accessed before construction completed.`);
    this.beanId = input.beanId;
    this.constructionPath = Object.freeze([...input.constructionPath]);
  }
}

export class BeanCreationError extends ReforceRuntimeError<"BEAN_CREATION_FAILED"> {
  readonly code = "BEAN_CREATION_FAILED" as const;
  readonly beanId: string;
  readonly dependencyPath: readonly string[];

  constructor(input: {
    readonly beanId: string;
    readonly dependencyPath: readonly string[];
    readonly cause: unknown;
  }) {
    super(`Bean "${input.beanId}" could not be created.`, {
      cause: input.cause,
    });
    this.beanId = input.beanId;
    this.dependencyPath = Object.freeze([...input.dependencyPath]);
  }
}

export class BeanLifecycleError extends ReforceRuntimeError<"BEAN_LIFECYCLE_FAILED"> {
  readonly code = "BEAN_LIFECYCLE_FAILED" as const;
  readonly beanId: string;
  readonly phase: "start" | "close";

  constructor(input: {
    readonly beanId: string;
    readonly phase: "start" | "close";
    readonly cause: unknown;
  }) {
    super(`Bean "${input.beanId}" failed during ${input.phase}.`, {
      cause: input.cause,
    });
    this.beanId = input.beanId;
    this.phase = input.phase;
  }
}

export class BeanDisposalError extends ReforceRuntimeError<"BEAN_DISPOSAL_FAILED"> {
  readonly code = "BEAN_DISPOSAL_FAILED" as const;
  readonly beanId: string;

  constructor(input: { readonly beanId: string; readonly cause: unknown }) {
    super(`Factory Bean "${input.beanId}" could not be disposed.`, {
      cause: input.cause,
    });
    this.beanId = input.beanId;
  }
}

export type CleanupActionError = BeanLifecycleError | BeanDisposalError;

export class ApplicationStartError extends ReforceRuntimeError<"APPLICATION_START_FAILED"> {
  readonly code = "APPLICATION_START_FAILED" as const;
  override readonly cause: ReforceRuntimeError;
  override readonly errors: readonly CleanupActionError[];

  constructor(input: {
    readonly cause: ReforceRuntimeError;
    readonly errors: readonly CleanupActionError[];
  }) {
    const errors = Object.freeze([...input.errors]);
    super("Application Context startup failed.", {
      cause: input.cause,
      errors,
    });
    this.cause = input.cause;
    this.errors = errors;
  }
}

export class ApplicationCleanupError extends ReforceRuntimeError<"APPLICATION_CLEANUP_FAILED"> {
  readonly code = "APPLICATION_CLEANUP_FAILED" as const;
  override readonly errors: readonly CleanupActionError[];

  constructor(errors: readonly CleanupActionError[]) {
    const snapshot = Object.freeze([...errors]);
    super("Application Context cleanup failed.", { errors: snapshot });
    this.errors = snapshot;
  }
}

function describeTarget(target: unknown): string {
  if (typeof target === "function") {
    return target.name.length > 0 ? `function ${target.name}` : "anonymous function";
  }
  if (target === null) {
    return "null";
  }
  return typeof target;
}

export class UnregisteredBeanTargetError extends ReforceRuntimeError<"UNREGISTERED_BEAN_TARGET"> {
  readonly code = "UNREGISTERED_BEAN_TARGET" as const;
  readonly target: unknown;

  constructor(target: unknown) {
    super(`No Bean is registered for ${describeTarget(target)}.`);
    this.target = target;
  }
}

export class ApplicationContextStateError extends ReforceRuntimeError<"APPLICATION_CONTEXT_STATE"> {
  readonly code = "APPLICATION_CONTEXT_STATE" as const;
  readonly operation: ContextOperation;
  readonly state: ContextState;

  constructor(input: {
    readonly operation: ContextOperation;
    readonly state: ContextState;
  }) {
    super(`Application Context cannot perform "${input.operation}" while ${input.state}.`);
    this.operation = input.operation;
    this.state = input.state;
  }
}

export class InvalidGeneratedDefinitionError extends ReforceRuntimeError<"INVALID_GENERATED_DEFINITION"> {
  readonly code = "INVALID_GENERATED_DEFINITION" as const;
  readonly detail: string;

  constructor(detail: string, options: { readonly cause?: unknown } = {}) {
    super(`Generated application definition is invalid: ${detail}`, options);
    this.detail = detail;
  }
}
