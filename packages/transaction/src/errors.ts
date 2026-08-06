import { ReforceRuntimeError } from "@reforce/context";
import type { TransactionIsolation } from "@/manager";

// 事务运行时错误（ADR 0008 T3/T4，#204 定案 5）：共同原则是消灭静默降级——savepoint 缺失
// 不退化为 REQUIRED，加入事务时的 isolation 声明不静默忽略（Spring 默认静默、要开
// validateExistingTransaction 才拒绝；我们默认即拒绝）。
//
// 全部继续继承 @reforce/context 的 ReforceRuntimeError：拦截器契约里那条「兜底拦截器要
// `if (error instanceof ReforceRuntimeError) throw error`」的放行纪律必须同时覆盖这四个护栏
// 错误，否则拆包就等于把它们从护栏名单里划掉。

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
