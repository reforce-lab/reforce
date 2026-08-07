import { describe, expect, test } from "vitest";
import { InterceptorReenteredError, isReforceError, UnregisteredBeanTargetError } from "@/errors";

// 谱系识别（ADR 0013 决议 1，#280）：判据是 Symbol.for("reforce.error") 标记加 code 形态，
// 不是 instanceof——@reforce/core 被装成两份物理拷贝时 instanceof 会把另一份抛的框架错误判否，
// 而兜底拦截器的放行纪律、reporter 的取码取 help 全都挂在这个判据上。
describe("isReforceError", () => {
  test("accepts an error from the lineage", () => {
    expect(isReforceError(new UnregisteredBeanTargetError(class Absent {}))).toBe(true);
  });

  test("rejects a bare Error", () => {
    expect(isReforceError(new Error("boom"))).toBe(false);
  });

  test("rejects an error that only looks the part", () => {
    expect(isReforceError(Object.assign(new Error("boom"), { code: "BEAN_CREATION_FAILED" }))).toBe(
      false,
    );
  });

  // 第二份物理拷贝的等价物：带标记、带 code，但原型链上没有本包的 ReforceError。
  test("accepts a marked error from another copy of the package", () => {
    const foreign = new Error("boom");
    Object.defineProperty(foreign, Symbol.for("reforce.error"), { value: true });
    Object.defineProperty(foreign, "code", { value: "BEAN_CREATION_FAILED" });

    expect(isReforceError(foreign)).toBe(true);
  });

  test("rejects a marked value whose code is not a string", () => {
    const malformed = { code: 42 };
    Object.defineProperty(malformed, Symbol.for("reforce.error"), { value: true });

    expect(isReforceError(malformed)).toBe(false);
  });
});

// 标记不进任何序列化面：结构化日志展开字段、JSON.stringify、toEqual 的对象比较都不该看见它。
test("the lineage marker stays off the enumerable surface", () => {
  const error = new UnregisteredBeanTargetError(class Absent {});

  expect(Object.getOwnPropertyDescriptor(error, Symbol.for("reforce.error"))).toEqual({
    value: true,
    writable: false,
    enumerable: false,
    configurable: false,
  });
});

// RFC 0011 D5（#242）的分工：message 说「发生了什么」，help 说「下一步怎么办」，reporter 在
// human 模式下把后者单独渲染成 `= help:`。这条错误此前把两句并在 message 里（#282）。
describe("InterceptorReenteredError", () => {
  test("states only what happened in the message", () => {
    const error = new InterceptorReenteredError({ beanId: "app#Orders", method: "save" });

    expect(error.message).toBe(
      'An interceptor on "app#Orders.save" called next() more than once; the interception chain is not re-entrant.',
    );
  });

  test("carries the next step in the help channel", () => {
    const error = new InterceptorReenteredError({ beanId: "app#Orders", method: "save" });

    expect(error.help).toBe(
      "Retry at the call site instead: each call opens a fresh chain and a fresh transaction.",
    );
  });
});
