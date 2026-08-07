import { markReforceError, reforceErrorMarker } from "@/error-marker";
import type { ContextOperation, ContextState } from "@/public-types";

export interface ReforceErrorOptions {
  readonly cause?: unknown;
  readonly errors?: readonly unknown[];
  readonly help?: string;
}

// Code 的上界是 string 而不是 CoreErrorCode：框架包（@reforce/transaction 起）在自己的包里
// 声明自己的码，容器无从枚举。全仓零穷尽 switch、零 Record<CoreErrorCode, …>，reporter 本来
// 就把 code 坦成 string（ADR 0009），因此放宽不丢任何检查。
//
// 全框架单一基类、每个包一棵子树（ADR 0013 决议 1）：@reforce/web 的 ReforceWebError、
// @reforce/cli 的 ReforceCliError、@reforce/transaction 的七个护栏错误共用这个根。#246 决议 5
// 那条兜底拦截器放行纪律（`if (isReforceError(error)) throw error`）因此一次覆盖全域。
export abstract class ReforceError<Code extends string = string> extends Error {
  abstract readonly code: Code;
  // TS disallows combining declare with override; declare alone already keeps the
  // field type-only, so super(message, { cause }) is not clobbered by a field init.
  declare readonly cause?: unknown;
  readonly errors?: readonly unknown[];
  // 运行期错误与编译期诊断同框（RFC 0011 D5，#242）：help 说「下一步怎么办」，与 message 说
  // 「发生了什么」分开。reporter 在 human 模式下沿 cause 链取第一条 help 渲染成 `= help:`。
  readonly help?: string;

  protected constructor(message: string, options: ReforceErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.errors = options.errors;
    this.help = options.help;
    markReforceError(this);
  }
}

// 不写 `value instanceof Error`：dev HMR 的 Worker 边界会把错误结构化克隆，克隆件既丢原型也
// 丢 own symbol 属性——那种情况两种判据都救不回来；而 vm/realm 边界下 instanceof Error 会平白
// 判否。只看标记与 code 形态，判据与 realm 无关。
export function isReforceError(value: unknown): value is ReforceError {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, reforceErrorMarker) === true &&
    typeof Reflect.get(value, "code") === "string"
  );
}

export class EarlyBeanAccessError extends ReforceError<"EARLY_BEAN_ACCESS"> {
  readonly code = "EARLY_BEAN_ACCESS" as const;
  readonly beanId: string;
  readonly constructionPath: readonly string[];

  constructor(input: {
    readonly beanId: string;
    readonly constructionPath: readonly string[];
  }) {
    super(`Bean "${input.beanId}" was accessed before construction completed.`, {
      help: "Move the access out of the constructor: read the dependency inside a method, or declare an @OnStart hook that runs after every Bean is constructed.",
    });
    this.beanId = input.beanId;
    this.constructionPath = Object.freeze([...input.constructionPath]);
  }
}

export class BeanCreationError extends ReforceError<"BEAN_CREATION_FAILED"> {
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

export class BeanLifecycleError extends ReforceError<"BEAN_LIFECYCLE_FAILED"> {
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

export class BeanDisposalError extends ReforceError<"BEAN_DISPOSAL_FAILED"> {
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

export class ApplicationStartError extends ReforceError<"APPLICATION_START_FAILED"> {
  readonly code = "APPLICATION_START_FAILED" as const;
  declare readonly cause: ReforceError;
  declare readonly errors: readonly CleanupActionError[];

  constructor(input: {
    readonly cause: ReforceError;
    readonly errors: readonly CleanupActionError[];
  }) {
    const errors = Object.freeze([...input.errors]);
    super("Application Context startup failed.", {
      cause: input.cause,
      errors,
    });
  }
}

export class ApplicationCleanupError extends ReforceError<"APPLICATION_CLEANUP_FAILED"> {
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

export class ConfigBindingError extends ReforceError<"CONFIG_BINDING_FAILED"> {
  readonly code = "CONFIG_BINDING_FAILED" as const;
  readonly issues: readonly ConfigBindingIssue[];

  constructor(input: { readonly issues: readonly ConfigBindingIssue[] }) {
    const issues = Object.freeze([...input.issues]);
    super(
      [
        `Configuration binding failed with ${issues.length} issue(s):`,
        ...issues.map(renderConfigBindingIssue),
      ].join("\n"),
      {
        help: "Each issue names the environment key it expected. Set the missing keys, or fix the value so it parses into the declared property type.",
      },
    );
    this.issues = issues;
  }
}

// 请求作用域唯一的运行时失败模式（ADR 0006 W7）：请求外取请求态。Current 边点名双侧
// beanId，读者能直接定位是哪条句柄在请求外被调用；context.get 一侧只有目标可点名。
export class RequestContextMissingError extends ReforceError<"REQUEST_CONTEXT_MISSING"> {
  readonly code = "REQUEST_CONTEXT_MISSING" as const;
  readonly targetBeanId: string;
  readonly consumerBeanId?: string;

  constructor(input: { readonly targetBeanId: string; readonly consumerBeanId?: string }) {
    super(
      input.consumerBeanId === undefined
        ? `Request-scoped Bean "${input.targetBeanId}" was accessed outside an active request scope.`
        : `Current dependency of "${input.consumerBeanId}" onto "${input.targetBeanId}" was read outside an active request scope.`,
      {
        help: "Request-scoped Beans only exist while a request is being handled. Read them from a route handler or from a Bean that a route handler calls, not from startup code or a background task.",
      },
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

export class UnregisteredBeanTargetError extends ReforceError<"UNREGISTERED_BEAN_TARGET"> {
  readonly code = "UNREGISTERED_BEAN_TARGET" as const;
  readonly target: unknown;

  constructor(target: unknown) {
    super(`No Bean is registered for ${describeTarget(target)}.`, {
      help: "Only classes the compiler saw as providers can be resolved by target. Check that the class carries @Injectable and is reachable from the application entry, and rebuild.",
    });
    this.target = target;
  }
}

export class ApplicationContextStateError extends ReforceError<"APPLICATION_CONTEXT_STATE"> {
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

export class InvalidGeneratedDefinitionError extends ReforceError<"INVALID_GENERATED_DEFINITION"> {
  readonly code = "INVALID_GENERATED_DEFINITION" as const;
  readonly detail: string;

  constructor(detail: string, options: { readonly cause?: unknown } = {}) {
    super(`Generated application definition is invalid: ${detail}`, options);
    this.detail = detail;
  }
}

// 织入链重入（ADR 0008 AM1，#202 定案 2，#246 决议 5）：链不可重入是 v1 定案，违约信号因此
// 必须是框架错误词汇而不是裸 Error——它要经得起用户兜底拦截器的 catch（拦截器契约注释里那条
// instanceof 放行），也要能被 CLI 报出 code。不带 index：那是 dispatch 下标不是 entries 下标，
// 读者按它去数拦截器会数错。
export class InterceptorReenteredError extends ReforceError<"INTERCEPTOR_REENTERED"> {
  readonly code = "INTERCEPTOR_REENTERED" as const;
  readonly beanId: string;
  readonly method: string;

  constructor(input: { readonly beanId: string; readonly method: string }) {
    super(
      `An interceptor on "${input.beanId}.${input.method}" called next() more than once; the interception chain is not re-entrant.`,
      {
        help: "Retry at the call site instead: each call opens a fresh chain and a fresh transaction.",
      },
    );
    this.beanId = input.beanId;
    this.method = input.method;
  }
}
