import { describe, expect, test } from "bun:test";
import { ResponseSerializationError } from "@/errors";
import { createResponseSerializer } from "@/execution/serialization";
import {
  failingSchema,
  passthroughSchema,
  schemaOf,
  withEncode,
  withJsonSchema,
} from "../support/schemas";

describe("createResponseSerializer without a response schema", () => {
  test("passes a Response through untouched", async () => {
    const serialize = createResponseSerializer(undefined);
    const response = new Response("raw", { status: 201 });

    const result = await serialize(response);

    expect(result).toBe(response);
  });

  test("rejects a non-Response return value", () => {
    const serialize = createResponseSerializer(undefined);

    expect(serialize({ id: 1 })).rejects.toThrow(ResponseSerializationError);
  });
});

describe("createResponseSerializer with a validate-only schema", () => {
  test("serializes the validated value as JSON", async () => {
    const serialize = createResponseSerializer(passthroughSchema());

    const response = await serialize({ id: 7, name: "amy" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ id: 7, name: "amy" });
  });

  test("serializes bigint values as JSON strings", async () => {
    const serialize = createResponseSerializer(passthroughSchema());

    const response = await serialize({ id: 512887731683791700033n });

    expect(await response.text()).toBe('{"id":"512887731683791700033"}');
  });

  test("rejects a value that fails the response schema", () => {
    const serialize = createResponseSerializer(failingSchema("name is required"));

    expect(serialize({})).rejects.toThrow(ResponseSerializationError);
  });

  test("passes a Response through without validating it", async () => {
    const serialize = createResponseSerializer(failingSchema("never consulted"));
    const response = new Response("raw");

    const result = await serialize(response);

    expect(result).toBe(response);
  });
});

describe("createResponseSerializer with a Standard JSON Schema capable schema", () => {
  const userJsonSchema = {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      tags: { type: "array", items: { type: "object", properties: { label: {} } } },
    },
  };

  test("whitelists only the declared fields", async () => {
    const schema = withJsonSchema(passthroughSchema(), userJsonSchema);
    const serialize = createResponseSerializer(schema);

    const response = await serialize({
      id: "1",
      name: "amy",
      passwordHash: "secret",
      tags: [{ label: "a", internal: true }],
    });

    expect(await response.json()).toEqual({ id: "1", name: "amy", tags: [{ label: "a" }] });
  });

  test("keeps declared fields absent from the value absent", async () => {
    const schema = withJsonSchema(passthroughSchema(), userJsonSchema);
    const serialize = createResponseSerializer(schema);

    const response = await serialize({ id: "1" });

    expect(await response.json()).toEqual({ id: "1" });
  });

  test("falls back to plain validation when every target throws", async () => {
    const base = passthroughSchema();
    const schema = {
      ...base,
      "~standard": {
        ...base["~standard"],
        jsonSchema: {
          input: () => {
            throw new Error("unsupported target");
          },
          output: () => {
            throw new Error("unsupported target");
          },
        },
      },
    };
    const serialize = createResponseSerializer(schema);

    const response = await serialize({ id: "1", extra: true });

    expect(await response.json()).toEqual({ id: "1", extra: true });
  });
});

describe("createResponseSerializer with an encode-capable schema", () => {
  test("encodes runtime values to the wire shape before serializing", async () => {
    // 雪花 ID 语义：runtime bigint → wire string，由 codec 自己完成。
    const schema = withEncode(passthroughSchema(), (value) => ({
      id: String(Reflect.get(Object(value), "id")),
    }));
    const serialize = createResponseSerializer(schema);

    const response = await serialize({ id: 42n });

    expect(await response.text()).toBe('{"id":"42"}');
  });

  test("wraps an encode failure as a serialization error", () => {
    const schema = withEncode(passthroughSchema(), () => {
      throw new Error("cannot encode");
    });
    const serialize = createResponseSerializer(schema);

    expect(serialize({})).rejects.toThrow(ResponseSerializationError);
  });
});

describe("createResponseSerializer JSON rendering", () => {
  test("rejects a value JSON.stringify cannot render", () => {
    const serialize = createResponseSerializer(schemaOf(() => ({ value: undefined })));

    expect(serialize("anything")).rejects.toThrow(ResponseSerializationError);
  });

  // 以下三例钉住 Issue #198 的快路径回退：无 replacer 的首次 stringify 撞上 bigint 会在任意
  // 深度抛 TypeError，回退重试必须覆盖整棵树，而非 bigint 的 TypeError 不得被吞。
  test("serializes a nested bigint as a JSON string", async () => {
    const serialize = createResponseSerializer(passthroughSchema());

    const response = await serialize({ page: { cursor: 512887731683791700033n } });

    expect(await response.text()).toBe('{"page":{"cursor":"512887731683791700033"}}');
  });

  test("serializes bigint elements inside an array", async () => {
    const serialize = createResponseSerializer(passthroughSchema());

    const response = await serialize({ ids: [1n, 2n] });

    expect(await response.text()).toBe('{"ids":["1","2"]}');
  });

  test("propagates the TypeError of a circular structure", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const serialize = createResponseSerializer(passthroughSchema());

    expect(serialize(circular)).rejects.toThrow(TypeError);
  });
});
