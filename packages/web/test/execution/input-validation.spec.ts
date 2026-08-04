import { describe, expect, test } from "bun:test";
import { RequestValidationError } from "@/errors";
import { createRequestInputValidator } from "@/execution/input-validation";
import { RequestContextState } from "@/execution/request-context";
import { failingSchema, schemaOf } from "../support/schemas";

function contextOf(inputs: {
  readonly url?: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly body?: string;
}): RequestContextState {
  const url = inputs.url ?? "https://reforce.test/users/42";
  const request =
    inputs.body === undefined
      ? new Request(url)
      : new Request(url, {
          method: "POST",
          body: inputs.body,
          headers: { "content-type": "application/json" },
        });
  return new RequestContextState({
    request,
    url: new URL(url),
    method: inputs.body === undefined ? "GET" : "POST",
    path: "/users/:id",
    params: inputs.params ?? {},
    meta: {},
  });
}

describe("createRequestInputValidator", () => {
  test("replaces params with the decoded validation output", async () => {
    // 转换即校验的一部分（ADR 0006 W5）：wire string → runtime bigint 的 codec decode。
    const validate = createRequestInputValidator({
      params: schemaOf((value) => ({
        value: { id: BigInt(String(Reflect.get(Object(value), "id"))) },
      })),
    });
    const context = contextOf({ params: { id: "42" } });

    await validate(context);

    expect(context.params).toEqual({ id: 42n });
  });

  test("replaces query with the validation output", async () => {
    const validate = createRequestInputValidator({
      query: schemaOf(() => ({ value: { limit: 10 } })),
    });
    const context = contextOf({ url: "https://reforce.test/users?limit=10" });

    await validate(context);

    expect(context.query).toEqual({ limit: 10 });
  });

  test("reads and validates the body only when a body schema is declared", async () => {
    const validate = createRequestInputValidator({
      body: schemaOf((value) => ({ value })),
    });
    const context = contextOf({ body: '{"name":"amy"}' });

    await validate(context);

    expect(context.body).toEqual({ name: "amy" });
  });

  test("leaves the body stream untouched without a body schema", async () => {
    const validate = createRequestInputValidator({});
    const context = contextOf({ body: '{"name":"amy"}' });

    await validate(context);

    expect(context.request.bodyUsed).toBe(false);
    expect(context.body).toBeUndefined();
  });

  test("rejects a failing input with the issue source", async () => {
    const validate = createRequestInputValidator({
      query: failingSchema("limit must be a number"),
    });
    const context = contextOf({});

    expect(validate(context)).rejects.toMatchObject({
      code: "REQUEST_VALIDATION_FAILED",
      source: "query",
    });
  });

  test("rejects a non-JSON body as a body validation failure", async () => {
    const validate = createRequestInputValidator({
      body: schemaOf((value) => ({ value })),
    });
    const context = contextOf({ body: "not-json" });

    expect(validate(context)).rejects.toBeInstanceOf(RequestValidationError);
  });
});
