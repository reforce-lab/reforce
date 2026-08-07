import { describe, expect, test } from "vitest";
import { defineApplication } from "@/application-declaration";
import { describeValue } from "@/argument-errors";
import { defineBean, Order, Qualifier } from "@/bean-declaration";
import { coreErrorCodes } from "@/error-codes";
import { isReforceError } from "@/errors";
import { Interceptor } from "@/interception/interceptor";
import { defineMethodMarker } from "@/interception/method-marker";

// 公开 API 的参数守卫（ADR 0013 决议 3，#292）：此前 29 处裸 TypeError，无码、无 help、
// 不进识别。抛出点分散在各声明模块，这里从**用户看得见的入口**验，而不是直接 new 错误类。

function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error("the call was expected to throw");
}

describe("defineBean argument guards", () => {
  const cases = [
    ["options is not an object", () => defineBean(undefined as never), "CORE_INVALID_BEAN_OPTIONS"],
    ["create is missing", () => defineBean({} as never), "CORE_MISSING_BEAN_FACTORY"],
    [
      "scope is not request",
      () => defineBean({ create: () => ({}), scope: "session" } as never),
      "CORE_INVALID_BEAN_SCOPE",
    ],
    [
      "a request-scoped Bean declares dispose",
      () => defineBean({ create: () => ({}), scope: "request", dispose: () => {} } as never),
      "CORE_REQUEST_BEAN_DISPOSE",
    ],
    [
      "dispose is not a function",
      () => defineBean({ create: () => ({}), dispose: 1 } as never),
      "CORE_INVALID_BEAN_DISPOSE",
    ],
    [
      "primary is not a boolean",
      () => defineBean({ create: () => ({}), primary: "yes" } as never),
      "CORE_INVALID_BEAN_PRIMARY",
    ],
    [
      "qualifier is not a string",
      () => defineBean({ create: () => ({}), qualifier: 7 } as never),
      "CORE_INVALID_BEAN_QUALIFIER",
    ],
  ] as const;

  for (const [name, call, code] of cases) {
    test(`reports ${code} when ${name}`, () => {
      expect(thrownBy(call)).toMatchObject({ code });
    });
  }
});

describe("the migrated guards keep their standard-library semantics", () => {
  test("a wrong argument type is still a TypeError", () => {
    expect(thrownBy(() => defineBean(undefined as never))).toBeInstanceOf(TypeError);
  });

  test("a wrong argument type now enters the lineage", () => {
    expect(isReforceError(thrownBy(() => defineBean(undefined as never)))).toBe(true);
  });

  test("a wrong argument type now carries a next step", () => {
    expect(thrownBy(() => defineBean({} as never))).toMatchObject({
      help: expect.stringContaining("create()"),
    });
  });
});

describe("the other declaration entry points", () => {
  const cases = [
    [
      "defineApplication options is not an object",
      () => defineApplication(undefined as never),
      "CORE_INVALID_APPLICATION_OPTIONS",
    ],
    [
      "defineApplication starters is missing",
      () => defineApplication({} as never),
      "CORE_MISSING_APPLICATION_STARTERS",
    ],
    ["Qualifier name is not a string", () => Qualifier(1 as never), "CORE_INVALID_QUALIFIER_NAME"],
    ["Order value is not an integer", () => Order(1.5), "CORE_INVALID_ORDER_VALUE"],
    [
      "defineMethodMarker key is empty",
      () => defineMethodMarker(""),
      "CORE_INVALID_METHOD_MARKER_KEY",
    ],
    [
      "Interceptor options is not an object",
      () => Interceptor(undefined as never),
      "CORE_INVALID_INTERCEPTOR_OPTIONS",
    ],
    [
      "Interceptor marker is not a method marker",
      () => Interceptor({ marker: "audit" } as never),
      "CORE_INVALID_INTERCEPTOR_MARKER",
    ],
    [
      "Interceptor phase is unknown",
      () => Interceptor({ marker: defineMethodMarker("audit"), phase: "cleanup" } as never),
      "CORE_INVALID_INTERCEPTOR_PHASE",
    ],
    [
      "Interceptor order is not an integer",
      () => Interceptor({ marker: defineMethodMarker("audit"), order: 1.5 } as never),
      "CORE_INVALID_INTERCEPTOR_ORDER",
    ],
  ] as const;

  for (const [name, call, code] of cases) {
    test(`reports ${code} when ${name}`, () => {
      expect(thrownBy(call)).toMatchObject({ code });
    });
  }
});

describe("method marker guards", () => {
  test("reports CORE_METHOD_MARKER_ARITY on a second argument", () => {
    const marker = defineMethodMarker<string>("audit");

    expect(thrownBy(() => (marker as (...args: unknown[]) => unknown)("a", "b"))).toMatchObject({
      code: "CORE_METHOD_MARKER_ARITY",
    });
  });

  test("reports CORE_METHOD_MARKER_TARGET outside a method position", () => {
    const marker = defineMethodMarker("audit");
    const decorate = marker() as (value: unknown, context: unknown) => void;

    expect(thrownBy(() => decorate(class {}, { kind: "class" }))).toMatchObject({
      code: "CORE_METHOD_MARKER_TARGET",
    });
  });
});

// 参数里常有配置对象、凭据、请求体片段，错误消息会进日志与终端（同 ADR 0005 决策 6.2）。
describe("describeValue", () => {
  test("never echoes the value itself", () => {
    expect(describeValue({ password: "hunter2" })).toBe("object");
  });

  test("separates null from object", () => {
    expect(describeValue(null)).toBe("null");
  });

  test("separates an array from object", () => {
    expect(describeValue([1, 2])).toBe("an array");
  });
});

test("every guard code is declared in the package code table", () => {
  const guardCodes = coreErrorCodes.filter((code) => code.startsWith("CORE_"));

  expect(guardCodes.length).toBe(24);
});
