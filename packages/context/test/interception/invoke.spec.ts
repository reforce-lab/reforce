import { describe, expect, test } from "vitest";
import { InterceptorReenteredError, ReforceRuntimeError } from "@/errors";
import type {
  MethodInterceptor,
  MethodInvocationContext,
  ReplacingMethodInterceptor,
} from "@/interception/interceptor";
import type { GeneratedInterceptorEntry, GeneratedMethodChain } from "@/interception/invoke";
import { invokeIntercepted } from "@/interception/invoke";
import type { MethodMetaValue } from "@/interception/method-marker";

// invokeIntercepted 是织入洋葱的唯一运行时入口（ADR 0008 AM1，#202 定案 2）：契约行为在
// 这里钉死——短路/替换返回值/异常转换/next 单次/ctx 冻结，生成代码只负责把链塞进来。
// 链按被织方法的返回类型参数化：改变返回值的拦截器必须是 ReplacingMethodInterceptor 并
// 绑定具体类型，透传型造不出 R（返回类型的类型层强制）。

function chainOf<R>(entries: readonly GeneratedInterceptorEntry<R>[]): GeneratedMethodChain<R> {
  return { beanId: "app#Sample", method: "save", entries };
}

function entryOf<R>(
  interceptor:
    | MethodInterceptor<MethodMetaValue | undefined>
    | ReplacingMethodInterceptor<MethodMetaValue | undefined, R>,
  value?: MethodMetaValue,
): GeneratedInterceptorEntry<R> {
  return { interceptor, value };
}

describe("invokeIntercepted", () => {
  test("an empty chain passes straight through to the terminal", async () => {
    const result = invokeIntercepted<Promise<string>>(chainOf<string>([]), ["a"], () =>
      Promise.resolve("saved"),
    );

    await expect(result).resolves.toBe("saved");
  });

  test("interceptors run in onion order around the terminal", async () => {
    const trace: string[] = [];
    const tracer = (label: string): MethodInterceptor => ({
      async intercept(_context, next) {
        trace.push(`${label}:before`);
        const result = await next();
        trace.push(`${label}:after`);
        return result;
      },
    });

    await invokeIntercepted<Promise<undefined>>(
      chainOf<undefined>([
        entryOf<undefined>(tracer("outer")),
        entryOf<undefined>(tracer("inner")),
      ]),
      [],
      async () => {
        trace.push("terminal");
        return undefined;
      },
    );

    expect(trace).toEqual([
      "outer:before",
      "inner:before",
      "terminal",
      "inner:after",
      "outer:after",
    ]);
  });

  test("the context exposes beanId, method, args, and the per-entry marker value", async () => {
    const seen: MethodInvocationContext[] = [];
    const witness: MethodInterceptor = {
      async intercept(context, next) {
        seen.push(context);
        return await next();
      },
    };

    await invokeIntercepted<Promise<undefined>>(
      chainOf<undefined>([
        entryOf<undefined>(witness, { label: "x" }),
        entryOf<undefined>(witness),
      ]),
      ["a", 1],
      () => Promise.resolve(undefined),
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]?.beanId).toBe("app#Sample");
    expect(seen[0]?.method).toBe("save");
    expect(seen[0]?.args).toEqual(["a", 1]);
    expect(seen[0]?.value).toEqual({ label: "x" });
    expect(seen[1]?.value).toBeUndefined();
  });

  test("the context and its args are frozen", async () => {
    const witness: MethodInterceptor = {
      async intercept(context, next) {
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.args)).toBe(true);
        return await next();
      },
    };

    await invokeIntercepted<Promise<undefined>>(
      chainOf<undefined>([entryOf<undefined>(witness)]),
      ["a"],
      () => Promise.resolve(undefined),
    );
  });

  test("skipping next() short-circuits the terminal and inner interceptors", async () => {
    let innerCalled = false;
    let terminalCalled = false;
    const shortCircuit: ReplacingMethodInterceptor<MethodMetaValue | undefined, string> = {
      async intercept() {
        return "cached";
      },
    };
    const inner: MethodInterceptor = {
      async intercept(_context, next) {
        innerCalled = true;
        return await next();
      },
    };

    const result = invokeIntercepted<Promise<string>>(
      chainOf<string>([entryOf<string>(shortCircuit), entryOf<string>(inner)]),
      [],
      async () => {
        terminalCalled = true;
        return "computed";
      },
    );

    await expect(result).resolves.toBe("cached");
    expect(innerCalled).toBe(false);
    expect(terminalCalled).toBe(false);
  });

  test("a replacing interceptor can replace the terminal return value", async () => {
    const replacer: ReplacingMethodInterceptor<MethodMetaValue | undefined, string> = {
      async intercept(_context, next) {
        await next();
        return "replaced";
      },
    };

    const result = invokeIntercepted<Promise<string>>(
      chainOf<string>([entryOf<string>(replacer)]),
      [],
      () => Promise.resolve("original"),
    );

    await expect(result).resolves.toBe("replaced");
  });

  test("a replacing interceptor can catch and transform a terminal failure", async () => {
    const recover: ReplacingMethodInterceptor<MethodMetaValue | undefined, string> = {
      async intercept(_context, next) {
        try {
          return await next();
        } catch (error) {
          return `recovered:${error instanceof Error ? error.message : String(error)}`;
        }
      },
    };

    const result = invokeIntercepted<Promise<string>>(
      chainOf<string>([entryOf<string>(recover)]),
      [],
      () => Promise.reject(new Error("boom")),
    );

    await expect(result).resolves.toBe("recovered:boom");
  });

  test("a pass-through interceptor can convert an exception without fabricating a value", async () => {
    const translate: MethodInterceptor = {
      async intercept(_context, next) {
        try {
          return await next();
        } catch (error) {
          throw new TypeError(`translated:${error instanceof Error ? error.message : ""}`);
        }
      },
    };

    const result = invokeIntercepted<Promise<string>>(
      chainOf<string>([entryOf<string>(translate)]),
      [],
      () => Promise.reject(new Error("boom")),
    );

    await expect(result).rejects.toThrow("translated:boom");
  });

  test("calling next() more than once is rejected", async () => {
    const doubleNext: MethodInterceptor = {
      async intercept(_context, next) {
        await next();
        return await next();
      },
    };

    const result = invokeIntercepted<Promise<undefined>>(
      chainOf<undefined>([entryOf<undefined>(doubleNext)]),
      [],
      () => Promise.resolve(undefined),
    );

    await expect(result).rejects.toThrow(InterceptorReenteredError);
    await expect(result).rejects.toMatchObject({
      code: "INTERCEPTOR_REENTERED",
      beanId: "app#Sample",
      method: "save",
    });
  });

  test("the re-entry failure names the woven method and the retry path that does work", async () => {
    const doubleNext: MethodInterceptor = {
      async intercept(_context, next) {
        await next();
        return await next();
      },
    };

    const result = invokeIntercepted<Promise<undefined>>(
      chainOf<undefined>([entryOf<undefined>(doubleNext)]),
      [],
      () => Promise.resolve(undefined),
    );

    await expect(result).rejects.toMatchObject({
      message: expect.stringContaining("app#Sample.save"),
    });
    await expect(result).rejects.toThrow("call site");
  });

  // 兜底拦截器吞掉框架护栏是本仓最贵的静默失败（#202 定案 2 配套纪律）：错误归队成
  // ReforceRuntimeError 之后，拦截器契约注释里那条 instanceof 放行才写得出来。裸 Error 时代
  // 这条用例会得到 "fallback" 而不是 reject。
  const fallbackOnBusinessFailure: ReplacingMethodInterceptor<MethodMetaValue | undefined, string> =
    {
      async intercept(_context, next) {
        try {
          return await next();
        } catch (error) {
          if (error instanceof ReforceRuntimeError) {
            throw error;
          }
          return "fallback";
        }
      },
    };

  test("a fallback interceptor lets a re-entry failure through", async () => {
    const buggyRetry: MethodInterceptor = {
      async intercept(_context, next) {
        let failure: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            return await next();
          } catch (error) {
            failure = error;
          }
        }
        throw failure;
      },
    };

    const result = invokeIntercepted<Promise<string>>(
      chainOf<string>([entryOf<string>(fallbackOnBusinessFailure), entryOf<string>(buggyRetry)]),
      [],
      () => Promise.reject(new Error("boom")),
    );

    await expect(result).rejects.toThrow(InterceptorReenteredError);
  });

  test("the same fallback interceptor still recovers from a business failure", async () => {
    const result = invokeIntercepted<Promise<string>>(
      chainOf<string>([entryOf<string>(fallbackOnBusinessFailure)]),
      [],
      () => Promise.reject(new Error("boom")),
    );

    await expect(result).resolves.toBe("fallback");
  });

  test("racing two next() calls is rejected", async () => {
    const parallelNext: MethodInterceptor = {
      async intercept(_context, next) {
        const [first] = await Promise.all([next(), next()]);
        return first;
      },
    };

    const result = invokeIntercepted<Promise<undefined>>(
      chainOf<undefined>([entryOf<undefined>(parallelNext)]),
      [],
      () => Promise.resolve(undefined),
    );

    await expect(result).rejects.toThrow(InterceptorReenteredError);
  });
});
