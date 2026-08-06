import type { ContextOperation, ContextState } from "@/public-types";
import type { TransactionIsolation } from "@/transaction/manager";

export type RuntimeErrorCode =
  | "EARLY_BEAN_ACCESS"
  | "BEAN_CREATION_FAILED"
  | "BEAN_LIFECYCLE_FAILED"
  | "BEAN_DISPOSAL_FAILED"
  | "APPLICATION_START_FAILED"
  | "APPLICATION_CLEANUP_FAILED"
  | "CONFIG_BINDING_FAILED"
  | "REQUEST_CONTEXT_MISSING"
  | "UNREGISTERED_BEAN_TARGET"
  | "APPLICATION_CONTEXT_STATE"
  | "INVALID_GENERATED_DEFINITION"
  | "TRANSACTION_SAVEPOINT_UNSUPPORTED"
  | "TRANSACTION_ISOLATION_ON_JOIN"
  | "TRANSACTION_ISOLATION_UNSUPPORTED"
  | "TRANSACTION_TIMEOUT_ON_JOIN"
  | "TRANSACTION_TIMEOUT_UNSUPPORTED"
  | "TRANSACTION_TIMEOUT"
  | "TRANSACTION_RESOURCE_REUSED";

interface RuntimeErrorOptions {
  readonly cause?: unknown;
  readonly errors?: readonly unknown[];
}

export abstract class ReforceRuntimeError<
  Code extends RuntimeErrorCode = RuntimeErrorCode,
> extends Error {
  abstract readonly code: Code;
  // TS disallows combining declare with override; declare alone already keeps the
  // field type-only, so super(message, { cause }) is not clobbered by a field init.
  declare readonly cause?: unknown;
  readonly errors?: readonly unknown[];

  protected constructor(message: string, options: RuntimeErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
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
  declare readonly cause: ReforceRuntimeError;
  declare readonly errors: readonly CleanupActionError[];

  constructor(input: {
    readonly cause: ReforceRuntimeError;
    readonly errors: readonly CleanupActionError[];
  }) {
    const errors = Object.freeze([...input.errors]);
    super("Application Context startup failed.", {
      cause: input.cause,
      errors,
    });
  }
}

export class ApplicationCleanupError extends ReforceRuntimeError<"APPLICATION_CLEANUP_FAILED"> {
  readonly code = "APPLICATION_CLEANUP_FAILED" as const;
  declare readonly errors: readonly CleanupActionError[];

  constructor(errors: readonly CleanupActionError[]) {
    const snapshot = Object.freeze([...errors]);
    super("Application Context cleanup failed.", { errors: snapshot });
  }
}

// 诊断数据永不携带配置值（ADR 0005 决策 6.2 的脱敏约定以"不打印"实现）：
// reason 只转述 schema 库的 issue 文案，layer/environmentVariable 定位来源。
export interface ConfigBindingIssue {
  readonly configId: string;
  readonly keyPath: readonly (string | number)[];
  readonly environmentVariable: string;
  readonly layer: string;
  readonly reason: string;
}

function renderConfigBindingIssue(issue: ConfigBindingIssue): string {
  return `- ${issue.configId}: ${issue.environmentVariable} (${issue.layer}): ${issue.reason}`;
}

export class ConfigBindingError extends ReforceRuntimeError<"CONFIG_BINDING_FAILED"> {
  readonly code = "CONFIG_BINDING_FAILED" as const;
  readonly issues: readonly ConfigBindingIssue[];

  constructor(input: { readonly issues: readonly ConfigBindingIssue[] }) {
    const issues = Object.freeze([...input.issues]);
    super(
      [
        `Configuration binding failed with ${issues.length} issue(s):`,
        ...issues.map(renderConfigBindingIssue),
      ].join("\n"),
    );
    this.issues = issues;
  }
}

// 请求作用域唯一的运行时失败模式（ADR 0006 W7）：请求外取请求态。Current 边点名双侧
// beanId，读者能直接定位是哪条句柄在请求外被调用；context.get 一侧只有目标可点名。
export class RequestContextMissingError extends ReforceRuntimeError<"REQUEST_CONTEXT_MISSING"> {
  readonly code = "REQUEST_CONTEXT_MISSING" as const;
  readonly targetBeanId: string;
  readonly consumerBeanId?: string;

  constructor(input: { readonly targetBeanId: string; readonly consumerBeanId?: string }) {
    super(
      input.consumerBeanId === undefined
        ? `Request-scoped Bean "${input.targetBeanId}" was accessed outside an active request scope.`
        : `Current dependency of "${input.consumerBeanId}" onto "${input.targetBeanId}" was read outside an active request scope.`,
    );
    this.targetBeanId = input.targetBeanId;
    this.consumerBeanId = input.consumerBeanId;
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

// 事务运行时错误（ADR 0008 T3/T4，#204 定案 5）：共同原则是消灭静默降级——savepoint 缺失
// 不退化为 REQUIRED，加入事务时的 isolation 声明不静默忽略（Spring 默认静默、要开
// validateExistingTransaction 才拒绝；我们默认即拒绝）。

export class TransactionSavepointUnsupportedError extends ReforceRuntimeError<"TRANSACTION_SAVEPOINT_UNSUPPORTED"> {
  readonly code = "TRANSACTION_SAVEPOINT_UNSUPPORTED" as const;
  readonly beanId: string;
  readonly method: string;

  constructor(input: { readonly beanId: string; readonly method: string }) {
    super(
      `NESTED transaction on "${input.beanId}.${input.method}" needs a savepoint, but the active TransactionManager does not implement withSavepoint().`,
    );
    this.beanId = input.beanId;
    this.method = input.method;
  }
}

export class TransactionIsolationOnJoinError extends ReforceRuntimeError<"TRANSACTION_ISOLATION_ON_JOIN"> {
  readonly code = "TRANSACTION_ISOLATION_ON_JOIN" as const;
  readonly beanId: string;
  readonly method: string;
  readonly declared: TransactionIsolation;
  readonly active: TransactionIsolation | undefined;

  constructor(input: {
    readonly beanId: string;
    readonly method: string;
    readonly declared: TransactionIsolation;
    readonly active: TransactionIsolation | undefined;
  }) {
    super(
      `"${input.beanId}.${input.method}" declares isolation "${input.declared}" but participates in an active transaction ${
        input.active === undefined ? "that declared no isolation" : `declared as "${input.active}"`
      }; a joined transaction cannot change isolation.`,
    );
    this.beanId = input.beanId;
    this.method = input.method;
    this.declared = input.declared;
    this.active = input.active;
  }
}

// 核心不抛这个错：它是给 adapter 的统一词汇——声明的隔离级别底层不支持时必须抛错，
// 不得静默降级到别的级别（#204 定案 2）。
export class TransactionIsolationUnsupportedError extends ReforceRuntimeError<"TRANSACTION_ISOLATION_UNSUPPORTED"> {
  readonly code = "TRANSACTION_ISOLATION_UNSUPPORTED" as const;
  readonly isolation: TransactionIsolation;

  constructor(input: { readonly isolation: TransactionIsolation; readonly cause?: unknown }) {
    super(
      `The underlying database does not support transaction isolation level "${input.isolation}".`,
      { cause: input.cause },
    );
    this.isolation = input.isolation;
  }
}

// timeout 族与 isolation 族并列而不抽成 TransactionOptionOnJoinError：Rule of Three 只有
// 两次重复，各自的诊断字段与文案也不同，保持重复。
export class TransactionTimeoutOnJoinError extends ReforceRuntimeError<"TRANSACTION_TIMEOUT_ON_JOIN"> {
  readonly code = "TRANSACTION_TIMEOUT_ON_JOIN" as const;
  readonly beanId: string;
  readonly method: string;
  readonly declared: number;
  readonly active: number | undefined;

  constructor(input: {
    readonly beanId: string;
    readonly method: string;
    readonly declared: number;
    readonly active: number | undefined;
  }) {
    super(
      `"${input.beanId}.${input.method}" declares timeout ${input.declared}ms but participates in an active transaction ${
        input.active === undefined ? "that declared no timeout" : `declared as ${input.active}ms`
      }; an already open transaction cannot change its time budget.`,
    );
    this.beanId = input.beanId;
    this.method = input.method;
    this.declared = input.declared;
    this.active = input.active;
  }
}

// 核心不抛这个错：它是给 adapter 的统一词汇——底层不能精确实现"整个事务边界的墙钟上限"时
// 必须抛错，不得用 statement_timeout 一类语义不等价的近似冒充。
export class TransactionTimeoutUnsupportedError extends ReforceRuntimeError<"TRANSACTION_TIMEOUT_UNSUPPORTED"> {
  readonly code = "TRANSACTION_TIMEOUT_UNSUPPORTED" as const;
  readonly timeout: number;

  constructor(input: { readonly timeout: number; readonly cause?: unknown }) {
    super(
      `The underlying database driver cannot enforce a per-transaction timeout of ${input.timeout}ms.`,
      { cause: input.cause },
    );
    this.timeout = input.timeout;
  }
}

// 核心不抛这个错：adapter 把驱动私有的超时错误（Prisma P2028 等）映射成框架词汇，原错误
// 留在 cause 里——调用方 catch 一个类型即可，不必认得每家驱动的错误码。
export class TransactionTimeoutError extends ReforceRuntimeError<"TRANSACTION_TIMEOUT"> {
  readonly code = "TRANSACTION_TIMEOUT" as const;
  readonly timeout: number;

  constructor(input: { readonly timeout: number; readonly cause?: unknown }) {
    super(`Transaction exceeded its declared timeout of ${input.timeout}ms and was rolled back.`, {
      cause: input.cause,
    });
    this.timeout = input.timeout;
  }
}

// 运行时护栏（ADR 0008 T4）：REQUIRES_NEW 拿回了同一 manager 上某个被挂起边界的资源，说明
// withTransaction 没有开新事务。能力边界写在拦截器的护栏处——它只抓"直接把外层 resource
// 原样返回"这类粗糙实现。
export class TransactionResourceReusedError extends ReforceRuntimeError<"TRANSACTION_RESOURCE_REUSED"> {
  readonly code = "TRANSACTION_RESOURCE_REUSED" as const;
  readonly beanId: string;
  readonly method: string;

  constructor(input: { readonly beanId: string; readonly method: string }) {
    super(
      `REQUIRES_NEW on "${input.beanId}.${input.method}" received a resource that belongs to a suspended outer transaction; withTransaction() must begin a transaction unrelated to any outer one.`,
    );
    this.beanId = input.beanId;
    this.method = input.method;
  }
}
