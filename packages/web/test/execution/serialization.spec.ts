import { describe, expect, test } from "vitest";
import { ResponseSerializationError } from "@/errors";
import { serializeResponse } from "@/execution/serialization";
import type { GeneratedRouteResponse } from "@/generated/route-table";

// 响应三变体的分派契约(RFC 0012 S3,#275):table = 编码器 + 状态码;free-form = 原样序列化;
// passthrough = Response 逃生口 / void 空体。

const identity = (value: unknown): unknown => value;

function tableResponse(status = 200, encode = identity): GeneratedRouteResponse {
  return { kind: "table", status, encode };
}

const freeForm: GeneratedRouteResponse = { kind: "free-form", status: 200 };
const passthrough: GeneratedRouteResponse = { kind: "passthrough" };

describe("serializeResponse passthrough", () => {
  test("passes a Response through untouched under every kind", () => {
    const response = new Response("raw", { status: 201 });

    expect(serializeResponse(response, passthrough)).toBe(response);
    expect(serializeResponse(response, tableResponse())).toBe(response);
    expect(serializeResponse(response, freeForm)).toBe(response);
  });

  // 契约不得写成"带 content-length = 由 reforce 序列化产生"：raw Response 走透传通道，
  // 它自己带不带这个头都是合法的，这里钉住透传不会被加工。
  test("leaves a passed-through Response without adding content-length", () => {
    const response = serializeResponse(new Response("ok"), passthrough);

    expect(response.headers.get("content-length")).toBeNull();
  });

  test("answers an undefined return with an empty 204 body", async () => {
    const response = serializeResponse(undefined, passthrough);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("a declared status overrides the 204 default for void routes", () => {
    const response = serializeResponse(undefined, { kind: "passthrough", status: 202 });

    expect(response.status).toBe(202);
  });

  test("rejects a non-Response value on a passthrough route", () => {
    expect(() => serializeResponse({ id: 1 }, passthrough)).toThrow(ResponseSerializationError);
  });
});

describe("serializeResponse with a table contract", () => {
  test("encodes the value before serializing it as JSON", async () => {
    // 白名单投影编码器的运行时接线:投影产物才是出线形状。
    const encode = (value: unknown): unknown => ({ id: Reflect.get(Object(value), "id") });

    const response = serializeResponse(
      { id: 7, passwordHash: "secret" },
      tableResponse(200, encode),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ id: 7 });
  });

  test("stamps the declared status onto the serialized response", () => {
    const response = serializeResponse({ id: 7 }, tableResponse(201));

    expect(response.status).toBe(201);
  });

  test("serializes bigint values as JSON strings", async () => {
    const response = serializeResponse({ id: 512887731683791700033n }, tableResponse());

    expect(await response.text()).toBe('{"id":"512887731683791700033"}');
  });

  // content-length 是适配器的缓冲/流式判据（adapter.ts 的契约块）；new Response(str) 不自动
  // 带这个头，所以显式设是有意义的。
  test("declares content-length so adapters can take the buffered path", () => {
    const response = serializeResponse({ id: 7 }, tableResponse());

    // {"id":7} = 8 字节
    expect(response.headers.get("content-length")).toBe("8");
  });

  // 必须是字节数而不是字符数：JSON.stringify 不转义非 ASCII，"汉字" 是 2 char / 6 byte。
  test("counts content-length in bytes, not characters", async () => {
    const response = serializeResponse({ n: "汉字" }, tableResponse());

    const body = await response.clone().text();
    expect(body).toBe('{"n":"汉字"}');
    expect(response.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(body).length),
    );
  });

  test("rejects an encoded value JSON.stringify cannot render", () => {
    expect(() =>
      serializeResponse(
        "anything",
        tableResponse(200, () => undefined),
      ),
    ).toThrow(ResponseSerializationError);
  });
});

describe("serializeResponse with a free-form response", () => {
  // 降级语义(#275):无契约声明且推导失败的路由不投影不白名单,返回值原样序列化。
  test("serializes the raw value without any projection", async () => {
    const response = serializeResponse({ id: 7, passwordHash: "leaks" }, freeForm);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 7, passwordHash: "leaks" });
  });

  test("keeps the bigint retry path and Date toJSON on the raw value", async () => {
    const response = serializeResponse(
      { id: 42n, at: new Date("2026-01-02T03:04:05.000Z") },
      freeForm,
    );

    expect(await response.json()).toEqual({ id: "42", at: "2026-01-02T03:04:05.000Z" });
  });

  test("renders NaN and Infinity as null, matching JSON.stringify", async () => {
    const response = serializeResponse(
      { a: Number.NaN, b: Number.POSITIVE_INFINITY },
      { kind: "free-form", status: 200 },
    );

    expect(await response.json()).toEqual({ a: null, b: null });
  });

  test("stamps the declared status", () => {
    expect(serializeResponse({ ok: true }, { kind: "free-form", status: 202 }).status).toBe(202);
  });

  test("rejects an undefined return (not JSON)", () => {
    expect(() => serializeResponse(undefined, freeForm)).toThrow(ResponseSerializationError);
  });
});

describe("serializeResponse JSON rendering", () => {
  // 以下三例钉住 Issue #198 的快路径回退：无 replacer 的首次 stringify 撞上 bigint 会在任意
  // 深度抛 TypeError，回退重试必须覆盖整棵树，而非 bigint 的 TypeError 不得被吞。
  test("serializes a nested bigint as a JSON string", async () => {
    const response = serializeResponse(
      { page: { cursor: 512887731683791700033n } },
      tableResponse(),
    );

    expect(await response.text()).toBe('{"page":{"cursor":"512887731683791700033"}}');
  });

  test("serializes bigint elements inside an array", async () => {
    const response = serializeResponse({ ids: [1n, 2n] }, tableResponse());

    expect(await response.text()).toBe('{"ids":["1","2"]}');
  });

  test("propagates the TypeError of a circular structure", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => serializeResponse(circular, tableResponse())).toThrow(TypeError);
  });
});
