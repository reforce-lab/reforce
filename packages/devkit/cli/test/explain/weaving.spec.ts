import { describe, expect, test } from "vitest";
import { parseGeneratedWeavingBytes, wovenMethodsOf } from "@/explain/weaving";

// 织入表信任边界（#204 定案 7）：形状镜像 compiler 的 generate-weaving-file；产物字节可能
// 被手改，非法形状一律拒绝而不是部分接受。

function bytesOf(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const chainEntry = {
  beanId: "@reforce/transaction#TransactionInterceptor",
  phase: "transaction",
  order: 0,
  marker: "transactional",
};

const table = {
  schemaVersion: 1,
  beans: [
    {
      beanId: "src/service.ts#OrderService",
      methods: [{ method: "save", markers: { transactional: null }, chain: [chainEntry] }],
    },
  ],
} as const;

describe("parseGeneratedWeavingBytes", () => {
  test("accepts a producer-shaped weaving table", () => {
    expect(parseGeneratedWeavingBytes(bytesOf(table))).toEqual(table);
  });

  test("accepts the unconditional empty table", () => {
    expect(parseGeneratedWeavingBytes(bytesOf({ schemaVersion: 1, beans: [] }))).toEqual({
      schemaVersion: 1,
      beans: [],
    });
  });

  test("rejects an unknown schema version", () => {
    expect(parseGeneratedWeavingBytes(bytesOf({ ...table, schemaVersion: 2 }))).toBeUndefined();
  });

  test("rejects a chain entry outside the phase closed set", () => {
    const tampered = {
      schemaVersion: 1,
      beans: [
        {
          beanId: "src/service.ts#OrderService",
          methods: [
            {
              method: "save",
              markers: {},
              chain: [{ ...chainEntry, phase: "before" }],
            },
          ],
        },
      ],
    };

    expect(parseGeneratedWeavingBytes(bytesOf(tampered))).toBeUndefined();
  });

  test("rejects a chain entry with extra keys", () => {
    const tampered = {
      schemaVersion: 1,
      beans: [
        {
          beanId: "src/service.ts#OrderService",
          methods: [
            {
              method: "save",
              markers: {},
              chain: [{ ...chainEntry, parameterIndex: 1 }],
            },
          ],
        },
      ],
    };

    expect(parseGeneratedWeavingBytes(bytesOf(tampered))).toBeUndefined();
  });

  test("rejects bytes that are not JSON", () => {
    expect(parseGeneratedWeavingBytes(new TextEncoder().encode("not json"))).toBeUndefined();
  });
});

describe("wovenMethodsOf", () => {
  test("returns the methods for a woven bean", () => {
    const parsed = parseGeneratedWeavingBytes(bytesOf(table));

    expect(parsed && wovenMethodsOf(parsed, "src/service.ts#OrderService")).toHaveLength(1);
  });

  test("returns an empty list for a bean that is not woven", () => {
    const parsed = parseGeneratedWeavingBytes(bytesOf(table));

    expect(parsed && wovenMethodsOf(parsed, "src/other.ts#Plain")).toEqual([]);
  });
});
