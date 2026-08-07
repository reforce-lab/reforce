import { isReforceError, ReforceError } from "@reforce/core";
import { describe, expect, test } from "vitest";
import { MiddlewareReenteredError, RequestValidationError } from "@/errors";

// web 子树并入统一谱系（ADR 0013 决议 1，#280）：此前 ReforceWebError 直接 extends Error，
// reporter 的取码与 help 通道对 web 错误全部关闭。
describe("the web subtree joins the ReforceError lineage", () => {
  test("a web error is recognized by the lineage guard", () => {
    expect(isReforceError(new RequestValidationError({ source: "body", issues: [] }))).toBe(true);
  });

  test("a web error is an instance of the shared root", () => {
    expect(new RequestValidationError({ source: "body", issues: [] })).toBeInstanceOf(ReforceError);
  });
});

// 与 InterceptorReenteredError 同款分工（#282）：message 说「发生了什么」，help 说「下一步
// 怎么办」，reporter 在 human 模式下把后者单独渲染成 `= help:`。
describe("MiddlewareReenteredError", () => {
  test("states only what happened in the message", () => {
    const error = new MiddlewareReenteredError({
      beanId: "app#ApiKeyMiddleware",
      method: "GET",
      path: "/greetings",
    });

    expect(error.message).toBe(
      'Middleware Bean "app#ApiKeyMiddleware" on GET /greetings called next() more than once; the middleware chain is not re-entrant.',
    );
  });

  test("carries the next step in the help channel", () => {
    const error = new MiddlewareReenteredError({
      beanId: "app#ApiKeyMiddleware",
      method: "GET",
      path: "/greetings",
    });

    expect(error.help).toBe(
      "next() runs the rest of the chain exactly once — put whatever has to happen afterwards after `await next()`.",
    );
  });
});
