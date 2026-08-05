import { describe, expect, test } from "vitest";
import { readTransactionalValue, Transactional } from "@/transaction/marker";

// @Transactional 走 AM1 标记通道（#204 定案 2）；readTransactionalValue 是拦截器入口的
// 运行时守卫，兜住未经编译的调用方（测试 N6 的守卫单元面）。

describe("Transactional", () => {
  test("binds the reserved marker key", () => {
    expect(Transactional.key).toBe("transactional");
  });
});

describe("readTransactionalValue", () => {
  test("passes through an absent value", () => {
    expect(readTransactionalValue(undefined)).toBeUndefined();
  });

  test("accepts an empty options object", () => {
    expect(readTransactionalValue({})).toEqual({});
  });

  test("accepts known propagation and isolation literals", () => {
    const value = readTransactionalValue({
      propagation: "REQUIRES_NEW",
      isolation: "SERIALIZABLE",
    });

    expect(value).toEqual({ propagation: "REQUIRES_NEW", isolation: "SERIALIZABLE" });
  });

  test("rejects non-object values", () => {
    expect(() => readTransactionalValue(null)).toThrow(TypeError);
    expect(() => readTransactionalValue("REQUIRED")).toThrow(TypeError);
    expect(() => readTransactionalValue(["REQUIRED"])).toThrow(TypeError);
  });

  test("rejects unknown option keys", () => {
    expect(() => readTransactionalValue({ timeout: 5 })).toThrow('does not include "timeout"');
  });

  test("rejects an unknown propagation literal", () => {
    expect(() => readTransactionalValue({ propagation: "MANDATORY" })).toThrow(
      "Transactional propagation must be one of",
    );
  });

  test("rejects an unknown isolation literal", () => {
    expect(() => readTransactionalValue({ isolation: "SNAPSHOT" })).toThrow(
      "Transactional isolation must be one of",
    );
  });
});
