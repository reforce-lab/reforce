import { describe, expect, test } from "vitest";
import { RequestValidationError } from "@/errors";
import { RequestContextState } from "@/execution/request-context";
import { createSlotExecutor } from "@/execution/slot-execution";
import type { GeneratedRouteSlot } from "@/generated/route-table";
import { failingSchema, schemaOf } from "../support/schemas";

function contextOf(inputs: {
  readonly url?: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  // 省略即 application/json；显式传 null 表示完全不设 content-type 头。
  readonly contentType?: string | null;
}): RequestContextState {
  const url = inputs.url ?? "https://reforce.test/users/42";
  const contentType = inputs.contentType === undefined ? "application/json" : inputs.contentType;
  const headers = new Headers(inputs.headers ?? {});
  if (inputs.body !== undefined && contentType !== null) {
    headers.set("content-type", contentType);
  }
  const request =
    inputs.body === undefined
      ? new Request(url, { headers })
      : new Request(url, { method: "POST", body: inputs.body, headers });
  return new RequestContextState({
    request,
    url: new URL(url),
    method: inputs.body === undefined ? "GET" : "POST",
    path: "/users/:id",
    params: inputs.params ?? {},
    meta: {},
  });
}

function capture(): { carrier: unknown; schema: ReturnType<typeof schemaOf<unknown>> } {
  const seen: { carrier: unknown; schema: ReturnType<typeof schemaOf<unknown>> } = {
    carrier: undefined,
    schema: schemaOf((value) => {
      seen.carrier = value;
      return { value };
    }),
  };
  return seen;
}

// —— 载体分派(#274 载体表):生成解码器吃原生载体,用户 schema 吃 plain object 快照 ——

describe("createSlotExecutor carriers for generated decoders", () => {
  test("a param decoder receives the raw path params record", async () => {
    const seen = capture();
    const execute = createSlotExecutor([{ slot: "param", key: "id", decode: seen.schema }]);

    await execute(contextOf({ params: { id: "42" } }));

    expect(seen.carrier).toEqual({ id: "42" });
  });

  test("a query decoder receives the live URLSearchParams with getAll semantics", async () => {
    const seen = capture();
    const execute = createSlotExecutor([{ slot: "query", key: "tag", decode: seen.schema }]);

    await execute(contextOf({ url: "https://reforce.test/users?tag=a&tag=b" }));

    expect(seen.carrier).toBeInstanceOf(URLSearchParams);
    expect((seen.carrier as URLSearchParams).getAll("tag")).toEqual(["a", "b"]);
  });

  test("a header decoder receives the native case-insensitive Headers", async () => {
    const seen = capture();
    const execute = createSlotExecutor([
      { slot: "header", key: "x-tenant-id", decode: seen.schema },
    ]);

    await execute(contextOf({ headers: { "X-Tenant-Id": "acme" } }));

    expect(seen.carrier).toBeInstanceOf(Headers);
    expect((seen.carrier as Headers).get("X-TENANT-ID")).toBe("acme");
  });

  test("a body decoder receives the strict-read JSON product", async () => {
    const seen = capture();
    const execute = createSlotExecutor([{ slot: "body", decode: seen.schema }]);

    await execute(contextOf({ body: '{"name":"amy"}' }));

    expect(seen.carrier).toEqual({ name: "amy" });
  });
});

describe("createSlotExecutor carriers for user schemas", () => {
  test("a query schema receives a plain snapshot, not URLSearchParams", async () => {
    const seen = capture();
    const execute = createSlotExecutor([{ slot: "query", schema: seen.schema }]);

    await execute(contextOf({ url: "https://reforce.test/users?limit=10&offset=0" }));

    expect(seen.carrier).not.toBeInstanceOf(URLSearchParams);
    expect(seen.carrier).toEqual({ limit: "10", offset: "0" });
  });

  test("a header schema receives a plain snapshot under lowercased keys", async () => {
    const seen = capture();
    const execute = createSlotExecutor([{ slot: "header", schema: seen.schema }]);

    await execute(contextOf({ headers: { "X-Tenant-Id": "acme" } }));

    expect(seen.carrier).not.toBeInstanceOf(Headers);
    expect(Reflect.get(Object(seen.carrier), "x-tenant-id")).toBe("acme");
  });

  test("a param schema receives the path params record", async () => {
    const seen = capture();
    const execute = createSlotExecutor([{ slot: "param", schema: seen.schema }]);

    await execute(contextOf({ params: { id: "7" } }));

    expect(seen.carrier).toEqual({ id: "7" });
  });
});

// —— 槽值落位:按 handler 参数序,裸槽位置留空 ——

describe("createSlotExecutor slot values", () => {
  test("decoded values land at their parameter indices with bare slots left empty", async () => {
    const execute = createSlotExecutor([
      { slot: "requestContext" },
      { slot: "param", key: "id", decode: schemaOf(() => ({ value: 42n })) },
      { slot: "responseHeaders" },
      { slot: "query", schema: schemaOf(() => ({ value: { limit: 10 } })) },
    ]);

    const values = await execute(contextOf({ params: { id: "42" } }));

    expect(values).toHaveLength(4);
    expect(values[0]).toBeUndefined();
    expect(values[1]).toBe(42n);
    expect(values[2]).toBeUndefined();
    expect(values[3]).toEqual({ limit: 10 });
  });

  test("an async schema's resolved value is awaited into its slot", async () => {
    const execute = createSlotExecutor([
      { slot: "param", schema: schemaOf(() => Promise.resolve({ value: { id: 1n } })) },
    ]);

    const values = await execute(contextOf({ params: { id: "1" } }));

    expect(values[0]).toEqual({ id: 1n });
  });

  test("a slot-free route touches nothing and yields an empty array", async () => {
    const execute = createSlotExecutor([]);
    const context = contextOf({ body: '{"name":"amy"}' });

    const values = await execute(context);

    expect(values).toEqual([]);
    expect(context.request.bodyUsed).toBe(false);
  });
});

// —— 严格读体(层①):content-type 只认 application/json,空体/坏 JSON 各有明确文案 ——

describe("createSlotExecutor strict body reading", () => {
  const bodySlot = (): readonly GeneratedRouteSlot[] => [
    { slot: "body", schema: schemaOf((value) => ({ value })) },
  ];

  test("rejects a missing content-type header", async () => {
    const context = contextOf({ body: '{"name":"amy"}', contentType: null });

    await expect(createSlotExecutor(bodySlot())(context)).rejects.toMatchObject({
      code: "REQUEST_VALIDATION_FAILED",
      source: "body",
      issues: [{ message: "content-type must be application/json" }],
    });
  });

  test("rejects a +json suffix media type", async () => {
    const context = contextOf({ body: '{"name":"amy"}', contentType: "application/vnd.acme+json" });

    await expect(createSlotExecutor(bodySlot())(context)).rejects.toMatchObject({
      issues: [{ message: "content-type must be application/json" }],
    });
  });

  test("rejects a form content type — forms parse in the handler, not the Body slot", async () => {
    const context = contextOf({
      body: "name=amy",
      contentType: "application/x-www-form-urlencoded",
    });

    await expect(createSlotExecutor(bodySlot())(context)).rejects.toBeInstanceOf(
      RequestValidationError,
    );
  });

  test("tolerates media type parameters and casing around application/json", async () => {
    const context = contextOf({
      body: '{"name":"amy"}',
      contentType: "Application/JSON; charset=utf-8",
    });

    const values = await createSlotExecutor(bodySlot())(context);

    expect(values[0]).toEqual({ name: "amy" });
  });

  test("rejects an empty body with a dedicated message", async () => {
    const context = contextOf({ body: "" });

    await expect(createSlotExecutor(bodySlot())(context)).rejects.toMatchObject({
      issues: [{ message: "request body is empty" }],
    });
  });

  test("rejects malformed JSON as a body validation failure", async () => {
    const context = contextOf({ body: "not-json" });

    await expect(createSlotExecutor(bodySlot())(context)).rejects.toMatchObject({
      code: "REQUEST_VALIDATION_FAILED",
      source: "body",
    });
  });

  test("reads the body stream once even when two slots consume it", async () => {
    const first = capture();
    const second = capture();
    const execute = createSlotExecutor([
      { slot: "body", decode: first.schema },
      { slot: "body", key: "name", decode: second.schema },
    ]);

    const values = await execute(contextOf({ body: '{"name":"amy"}' }));

    expect(first.carrier).toEqual({ name: "amy" });
    expect(second.carrier).toEqual({ name: "amy" });
    expect(values).toHaveLength(2);
  });
});

// —— 跨槽位收齐:所有槽的 issues 一次 400,source 取首错槽 ——

describe("createSlotExecutor cross-slot failure collection", () => {
  test("collects issues from every failing slot into one error with the first slot's source", async () => {
    const execute = createSlotExecutor([
      { slot: "query", key: "page", decode: failingSchema("page must be a number") },
      { slot: "header", key: "x-tenant-id", decode: failingSchema("x-tenant-id must be present") },
    ]);

    await expect(execute(contextOf({}))).rejects.toMatchObject({
      code: "REQUEST_VALIDATION_FAILED",
      source: "query",
      issues: [{ message: "page must be a number" }, { message: "x-tenant-id must be present" }],
    });
  });

  test("a body read failure joins the collection instead of preempting other slots", async () => {
    const seen = capture();
    const context = contextOf({ body: "not-json" });

    await expect(
      createSlotExecutor([
        { slot: "body", decode: schemaOf((value) => ({ value })) },
        { slot: "query", key: "page", decode: seen.schema },
      ])(context),
    ).rejects.toMatchObject({ source: "body" });
    expect(seen.carrier).toBeInstanceOf(URLSearchParams);
  });

  test("a schema that throws a non-validation error propagates as a failure, not a 400", async () => {
    const execute = createSlotExecutor([
      {
        slot: "param",
        schema: schemaOf(() => {
          throw new Error("schema implementation exploded");
        }),
      },
    ]);

    await expect(execute(contextOf({}))).rejects.toThrow("schema implementation exploded");
  });
});
