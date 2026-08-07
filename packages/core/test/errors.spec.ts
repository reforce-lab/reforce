import { describe, expect, test } from "vitest";
import { InterceptorReenteredError } from "@/errors";

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
