import { describe, expect, test } from "vitest";
import { ResponseSerializationError } from "@/errors";
import { ResponseHeaders } from "@/execution/response-headers";
import { serializeResponse } from "@/execution/serialization";
import type { GeneratedRouteResponse } from "@/generated/route-table";
import { readRouteBody, readRouteJson } from "../support/route-response";

// 头是调用方传进来的那一个实例（#340 决议 2：响应头单一通道），每个用例各起一个新的。
// 载体而不是标准 Headers（#373）：框架内部的响应头通道就是它，标准对象按需物化。
const headers = (): ResponseHeaders => new ResponseHeaders();

// 响应三变体的分派契约(RFC 0012 S3,#275):table = 编码器 + 状态码;free-form = 原样序列化;
// passthrough = Response 逃生口 / void 空体。

const identity = (value: unknown): unknown => value;

function tableResponse(status = 200, encode = identity): GeneratedRouteResponse {
  return { kind: "table", status, encode };
}

const freeForm: GeneratedRouteResponse = { kind: "free-form", status: 200 };
const passthrough: GeneratedRouteResponse = { kind: "passthrough" };

describe("serializeResponse passthrough", () => {
  // 逃生口在三种 kind 下都不投影、不盖状态码（RFC 0012 #264 决策 7）。#340 之后「透传」的
  // 实现是**吸收**：读 status/headers，body 连引用搬走。所以断言从「返回同一个对象」改成
  // 「状态码原样、body 是同一个引用且没被消费」——后者才是这条契约真正要保证的东西，前者
  // 只是旧实现的副产品。
  test("absorbs a Response under every kind without touching its status or body", () => {
    for (const kind of [passthrough, tableResponse(), freeForm]) {
      expect(serializeResponse(new Response("raw", { status: 201 }), kind, headers()).status).toBe(
        201,
      );
    }

    const response = new Response("raw", { status: 201 });
    const absorbed = serializeResponse(response, passthrough, headers());

    expect(absorbed.body).toBe(response.body);
    expect(response.bodyUsed).toBe(false);
  });

  // 契约不得写成"带 content-length = 由 reforce 序列化产生"：raw Response 走透传通道，
  // 它自己带不带这个头都是合法的，这里钉住透传不会被加工。
  test("leaves a passed-through Response without adding content-length", () => {
    const response = serializeResponse(new Response("ok"), passthrough, headers());

    expect(response.headers.get("content-length")).toBeNull();
  });

  test("answers an undefined return with an empty 204 body", async () => {
    const response = serializeResponse(undefined, passthrough, headers());

    expect(response.status).toBe(204);
    expect(await readRouteBody(response)).toBe("");
  });

  test("a declared status overrides the 204 default for void routes", () => {
    const response = serializeResponse(undefined, { kind: "passthrough", status: 202 }, headers());

    expect(response.status).toBe(202);
  });

  test("rejects a non-Response value on a passthrough route", () => {
    expect(() => serializeResponse({ id: 1 }, passthrough, headers())).toThrow(
      ResponseSerializationError,
    );
  });
});

describe("serializeResponse with a table contract", () => {
  test("encodes the value before serializing it as JSON", async () => {
    // 白名单投影编码器的运行时接线:投影产物才是出线形状。
    const encode = (value: unknown): unknown => ({ id: Reflect.get(Object(value), "id") });

    const response = serializeResponse(
      { id: 7, passwordHash: "secret" },
      tableResponse(200, encode),
      headers(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await readRouteJson(response)).toEqual({ id: 7 });
  });

  test("stamps the declared status onto the serialized response", () => {
    const response = serializeResponse({ id: 7 }, tableResponse(201), headers());

    expect(response.status).toBe(201);
  });

  test("serializes bigint values as JSON strings", async () => {
    const response = serializeResponse({ id: 512887731683791700033n }, tableResponse(), headers());

    expect(await readRouteBody(response)).toBe('{"id":"512887731683791700033"}');
  });

  // content-length 是适配器的缓冲/流式判据（adapter.ts 的契约块）；new Response(str) 不自动
  // 带这个头，所以显式设是有意义的。
  test("declares content-length so adapters can take the buffered path", () => {
    const response = serializeResponse({ id: 7 }, tableResponse(), headers());

    // {"id":7} = 8 字节
    expect(response.headers.get("content-length")).toBe("8");
  });

  // 必须是字节数而不是字符数：JSON.stringify 不转义非 ASCII，"汉字" 是 2 char / 6 byte。
  test("counts content-length in bytes, not characters", async () => {
    const response = serializeResponse({ n: "汉字" }, tableResponse(), headers());

    const body = await readRouteBody(response);
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
        headers(),
      ),
    ).toThrow(ResponseSerializationError);
  });
});

describe("serializeResponse with a free-form response", () => {
  // 降级语义(#275):无契约声明且推导失败的路由不投影不白名单,返回值原样序列化。
  test("serializes the raw value without any projection", async () => {
    const response = serializeResponse({ id: 7, passwordHash: "leaks" }, freeForm, headers());

    expect(response.status).toBe(200);
    expect(await readRouteJson(response)).toEqual({ id: 7, passwordHash: "leaks" });
  });

  test("keeps the bigint retry path and Date toJSON on the raw value", async () => {
    const response = serializeResponse(
      { id: 42n, at: new Date("2026-01-02T03:04:05.000Z") },
      freeForm,
      headers(),
    );

    expect(await readRouteJson(response)).toEqual({ id: "42", at: "2026-01-02T03:04:05.000Z" });
  });

  test("renders NaN and Infinity as null, matching JSON.stringify", async () => {
    const response = serializeResponse(
      { a: Number.NaN, b: Number.POSITIVE_INFINITY },
      { kind: "free-form", status: 200 },
      headers(),
    );

    expect(await readRouteJson(response)).toEqual({ a: null, b: null });
  });

  test("stamps the declared status", () => {
    expect(
      serializeResponse({ ok: true }, { kind: "free-form", status: 202 }, headers()).status,
    ).toBe(202);
  });

  test("rejects an undefined return (not JSON)", () => {
    expect(() => serializeResponse(undefined, freeForm, headers())).toThrow(
      ResponseSerializationError,
    );
  });
});

describe("serializeResponse JSON rendering", () => {
  // 以下三例钉住 Issue #198 的快路径回退：无 replacer 的首次 stringify 撞上 bigint 会在任意
  // 深度抛 TypeError，回退重试必须覆盖整棵树，而非 bigint 的 TypeError 不得被吞。
  test("serializes a nested bigint as a JSON string", async () => {
    const response = serializeResponse(
      { page: { cursor: 512887731683791700033n } },
      tableResponse(),
      headers(),
    );

    expect(await readRouteBody(response)).toBe('{"page":{"cursor":"512887731683791700033"}}');
  });

  test("serializes bigint elements inside an array", async () => {
    const response = serializeResponse({ ids: [1n, 2n] }, tableResponse(), headers());

    expect(await readRouteBody(response)).toBe('{"ids":["1","2"]}');
  });

  test("propagates the TypeError of a circular structure", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => serializeResponse(circular, tableResponse(), headers())).toThrow(TypeError);
  });
});
