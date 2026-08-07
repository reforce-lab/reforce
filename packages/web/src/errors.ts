import { ReforceError } from "@reforce/core";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { WebErrorCode } from "@/error-codes";
import type { HttpMethod } from "@/routing/vocabulary";

// web 这一棵子树（ADR 0013 决议 1，#280）。此前它是独立的 `extends Error`，字段只有 code 与
// cause——reporter 的识别只认 @reforce/core 的基类，web 错误的码拿不到、help 通道对它们完全
// 关闭。并入同一个根之后两者一起打开，类型参数上界仍收在 WebErrorCode 上，本包的码保持闭集。
//
// 空类体：字段、protected 构造与 Symbol.for("reforce.error") 标记全部从根继承，这一层只做
// 「web 的码闭集」这一件事。
export abstract class ReforceWebError<
  Code extends WebErrorCode = WebErrorCode,
> extends ReforceError<Code> {}

export class InvalidRouteTableError extends ReforceWebError<"INVALID_ROUTE_TABLE"> {
  readonly code = "INVALID_ROUTE_TABLE" as const;
  readonly detail: string;

  constructor(detail: string) {
    super(`Generated route table is invalid: ${detail}`);
    this.detail = detail;
  }
}

// 洋葱链重入（ADR 0006 W4，#255）：链不可重入与 @reforce/core 的 InterceptorReenteredError
// 同款语义，违约信号因此同样必须是带码的框架错误——用户的 @ErrorHandler 要按 code 分派，
// 裸 Error 只能匹配 message 字符串。
//
// 点名 beanId 而不是层号：每条路由的链在编译期已按 beanId 去重，beanId 已经唯一定位那一层；
// 层号是 dispatch 下标不是链下标，读者拿它去数中间件会数错（同 #202 定案 2）。
//
// 与 InterceptorReenteredError 同款分工（#282）：message 说「发生了什么」，help 说「下一步
// 怎么办」，reporter 在 human 模式下把后者单独渲染成 `= help:`。
export class MiddlewareReenteredError extends ReforceWebError<"MIDDLEWARE_REENTERED"> {
  readonly code = "MIDDLEWARE_REENTERED" as const;
  readonly beanId: string;
  readonly method: HttpMethod;
  readonly path: string;

  constructor(input: {
    readonly beanId: string;
    readonly method: HttpMethod;
    readonly path: string;
  }) {
    super(
      `Middleware Bean "${input.beanId}" on ${input.method} ${input.path} called next() more than once; the middleware chain is not re-entrant.`,
      {
        help: "next() runs the rest of the chain exactly once — put whatever has to happen afterwards after `await next()`.",
      },
    );
    this.beanId = input.beanId;
    this.method = input.method;
    this.path = input.path;
  }
}

export type RequestInputSource = "body" | "params" | "query";

// 校验失败是请求级业务事实而非框架故障：作为错误抛出只为经错误处理器分派统一出口，
// 消息只转述 schema 库的 issue 文案，不携带请求值（与 ConfigBindingIssue 的脱敏约定同理）。
export class RequestValidationError extends ReforceWebError<"REQUEST_VALIDATION_FAILED"> {
  readonly code = "REQUEST_VALIDATION_FAILED" as const;
  readonly source: RequestInputSource;
  readonly issues: readonly StandardSchemaV1.Issue[];

  constructor(input: {
    readonly source: RequestInputSource;
    readonly issues: readonly StandardSchemaV1.Issue[];
  }) {
    const issues = Object.freeze([...input.issues]);
    super(
      [
        `Request ${input.source} failed validation with ${issues.length} issue(s):`,
        ...issues.map((issue) => `- ${issue.message}`),
      ].join("\n"),
    );
    this.source = input.source;
    this.issues = issues;
  }
}

export class ResponseSerializationError extends ReforceWebError<"RESPONSE_SERIALIZATION_FAILED"> {
  readonly code = "RESPONSE_SERIALIZATION_FAILED" as const;
  readonly detail: string;

  constructor(detail: string, options: { readonly cause?: unknown } = {}) {
    super(`Response serialization failed: ${detail}`, options);
    this.detail = detail;
  }
}
