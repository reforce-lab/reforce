import { describe, expect, test } from "vitest";
import { ResponseSerializationError } from "@/errors";
import { serializeResponse } from "@/execution/serialization";

const identity = (value: unknown): unknown => value;

describe("serializeResponse passthrough", () => {
  test("passes a Response through untouched, with or without an encoder", () => {
    const response = new Response("raw", { status: 201 });

    expect(serializeResponse(response, undefined)).toBe(response);
    expect(serializeResponse(response, identity)).toBe(response);
  });

  // 契约不得写成"带 content-length = 由 reforce 序列化产生"：raw Response 走透传通道，
  // 它自己带不带这个头都是合法的，这里钉住透传不会被加工。
  test("leaves a passed-through Response without adding content-length", () => {
    const response = serializeResponse(new Response("ok"), identity);

    expect(response.headers.get("content-length")).toBeNull();
  });

  // S2 中间态(#274):无返回类型标注的路由没有编码器,handler 必须自己返回 Response;
  // 普通对象序列化随 S3 的返回标注硬错解除。
  test("rejects a non-Response value when the route has no encoder", () => {
    expect(() => serializeResponse({ id: 1 }, undefined)).toThrow(ResponseSerializationError);
  });
});

describe("serializeResponse with an encoder", () => {
  test("encodes the value before serializing it as JSON", async () => {
    // 白名单投影编码器的运行时接线:投影产物才是出线形状。
    const encode = (value: unknown): unknown => ({ id: Reflect.get(Object(value), "id") });

    const response = serializeResponse({ id: 7, passwordHash: "secret" }, encode);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ id: 7 });
  });

  test("serializes bigint values as JSON strings", async () => {
    const response = serializeResponse({ id: 512887731683791700033n }, identity);

    expect(await response.text()).toBe('{"id":"512887731683791700033"}');
  });

  // content-length 是适配器的缓冲/流式判据（adapter.ts 的契约块）；new Response(str) 不自动
  // 带这个头，所以显式设是有意义的。
  test("declares content-length so adapters can take the buffered path", () => {
    const response = serializeResponse({ id: 7 }, identity);

    // {"id":7} = 8 字节
    expect(response.headers.get("content-length")).toBe("8");
  });

  // 必须是字节数而不是字符数：JSON.stringify 不转义非 ASCII，"汉字" 是 2 char / 6 byte。
  test("counts content-length in bytes, not characters", async () => {
    const response = serializeResponse({ n: "汉字" }, identity);

    const body = await response.clone().text();
    expect(body).toBe('{"n":"汉字"}');
    expect(response.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(body).length),
    );
  });

  test("rejects an encoded value JSON.stringify cannot render", () => {
    expect(() => serializeResponse("anything", () => undefined)).toThrow(
      ResponseSerializationError,
    );
  });
});

describe("serializeResponse JSON rendering", () => {
  // 以下三例钉住 Issue #198 的快路径回退：无 replacer 的首次 stringify 撞上 bigint 会在任意
  // 深度抛 TypeError，回退重试必须覆盖整棵树，而非 bigint 的 TypeError 不得被吞。
  test("serializes a nested bigint as a JSON string", async () => {
    const response = serializeResponse({ page: { cursor: 512887731683791700033n } }, identity);

    expect(await response.text()).toBe('{"page":{"cursor":"512887731683791700033"}}');
  });

  test("serializes bigint elements inside an array", async () => {
    const response = serializeResponse({ ids: [1n, 2n] }, identity);

    expect(await response.text()).toBe('{"ids":["1","2"]}');
  });

  test("propagates the TypeError of a circular structure", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => serializeResponse(circular, identity)).toThrow(TypeError);
  });
});
