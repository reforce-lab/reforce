import { describe, expect, test } from "bun:test";
import {
  Interceptor,
  type InterceptPhase,
  interceptPhases,
  isInterceptPhase,
} from "@/interception/interceptor";
import { defineMethodMarker } from "@/interception/method-marker";

// @Interceptor 与 @Middleware 同款纪律（ADR 0008 AM1，#202）：编译期静态读取、运行时 no-op、
// 参数守卫只服务未经编译的调用方。

const Audited = defineMethodMarker<{ label: string }>("audited");

describe("intercept phase vocabulary", () => {
  test("isInterceptPhase accepts exactly the closed five-phase set", () => {
    for (const phase of interceptPhases) {
      expect(isInterceptPhase(phase)).toBe(true);
    }
    expect(isInterceptPhase("security")).toBe(false);
    expect(isInterceptPhase(0)).toBe(false);
    expect(isInterceptPhase(undefined)).toBe(false);
  });
});

describe("Interceptor stays a runtime no-op", () => {
  test("a decorated class keeps its behavior and identity", async () => {
    @Interceptor({ marker: Audited, phase: "application", order: 1 })
    class Auditing {
      intercept(): Promise<unknown> {
        return Promise.resolve("intercepted");
      }
    }

    const auditing = new Auditing();

    expect(auditing).toBeInstanceOf(Auditing);
    await expect(auditing.intercept()).resolves.toBe("intercepted");
  });

  test("accepts every phase of the closed set", () => {
    for (const phase of interceptPhases) {
      expect(() => Interceptor({ marker: Audited, phase })).not.toThrow();
    }
  });
});

describe("Interceptor runtime guards", () => {
  test("rejects non-object options", () => {
    // 守卫服务未经编译的 JS 调用方，类型系统在这里被绕过 // justified: 见上一行
    expect(() => Interceptor(null as unknown as { marker: typeof Audited })).toThrow(TypeError);
  });

  test("rejects a missing marker", () => {
    // 守卫服务未经编译的 JS 调用方，类型系统在这里被绕过 // justified: 见上一行
    expect(() => Interceptor({} as unknown as { marker: typeof Audited })).toThrow(TypeError);
  });

  test("rejects a function without a marker key", () => {
    // 守卫服务未经编译的 JS 调用方，类型系统在这里被绕过 // justified: 见上一行
    expect(() => Interceptor({ marker: (() => undefined) as unknown as typeof Audited })).toThrow(
      TypeError,
    );
  });

  test("rejects an unknown phase", () => {
    // 守卫服务未经编译的 JS 调用方，类型系统在这里被绕过 // justified: 见上一行
    expect(() =>
      Interceptor({ marker: Audited, phase: "security" as unknown as InterceptPhase }),
    ).toThrow(TypeError);
  });

  test("rejects a non-integer order", () => {
    expect(() => Interceptor({ marker: Audited, order: 1.5 })).toThrow(TypeError);
    expect(() => Interceptor({ marker: Audited, order: Number.NaN })).toThrow(TypeError);
  });
});
