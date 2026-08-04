import type { StandardSchemaV1 } from "@standard-schema/spec";

export type WebErrorCode =
  | "INVALID_ROUTE_TABLE"
  | "REQUEST_VALIDATION_FAILED"
  | "RESPONSE_SERIALIZATION_FAILED";

export abstract class ReforceWebError<Code extends WebErrorCode = WebErrorCode> extends Error {
  abstract readonly code: Code;
  declare readonly cause?: unknown;

  protected constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
  }
}

export class InvalidRouteTableError extends ReforceWebError<"INVALID_ROUTE_TABLE"> {
  readonly code = "INVALID_ROUTE_TABLE" as const;
  readonly detail: string;

  constructor(detail: string) {
    super(`Generated route table is invalid: ${detail}`);
    this.detail = detail;
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
