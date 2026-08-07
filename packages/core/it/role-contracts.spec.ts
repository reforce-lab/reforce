import { describe, expect, test } from "vitest";
import type {
  InterceptHandle,
  MethodInterceptor,
  MethodInvocationContext,
  ReplacingInterceptHandle,
  ReplacingMethodInterceptor,
} from "@/interception/interceptor";
import { Interceptor } from "@/interception/interceptor";
import { defineMethodMarker } from "@/interception/method-marker";

// 角色契约的类型层证据（ADR 0008 AM1，与 web 的 role-contracts.spec.ts 同族）：@Interceptor
// 钉死 intercept 的形状与 marker 值类型，约束只在 typecheck 阶段有效，运行时装饰器是 no-op。
// 这些用例靠 @ts-expect-error 断言——指令没被触发时 tsc 反过来报 "unused directive"，因此
// packages/core 的 typecheck 就是它们的裁判（it/public-api.spec.ts 同款做法，Issue #106）。

const Audited = defineMethodMarker<{ readonly label: string }>("audited-role-contract");

function acceptsThePassThroughMethodForm(): void {
  @Interceptor({ marker: Audited })
  class Observability implements MethodInterceptor<{ label: string }> {
    async intercept<R>(
      context: MethodInvocationContext<{ label: string }>,
      next: () => Promise<R>,
    ): Promise<R> {
      void context.value.label;
      return await next();
    }
  }
  void Observability;
}

function acceptsTheReplacingMethodForm(): void {
  @Interceptor({ marker: Audited })
  class Appending implements ReplacingMethodInterceptor<{ label: string }, readonly string[]> {
    async intercept(
      context: MethodInvocationContext<{ label: string }>,
      next: () => Promise<readonly string[]>,
    ): Promise<readonly string[]> {
      return [...(await next()), context.value.label];
    }
  }
  void Appending;
}

function acceptsTheFieldFormWithZeroParameterAnnotations(): void {
  @Interceptor({ marker: Audited })
  class FieldPassThrough {
    // 上下文类型位置：参数类型由 InterceptHandle 推导，写法上零标注。
    readonly intercept: InterceptHandle<{ label: string }> = async (context, next) => {
      void context.value.label;
      return await next();
    };
  }

  @Interceptor({ marker: Audited })
  class FieldReplacing {
    readonly intercept: ReplacingInterceptHandle<{ label: string }, readonly string[]> = async (
      context,
      next,
    ) => [...(await next()), `audited:${context.value.label}`];
  }

  void FieldPassThrough;
  void FieldReplacing;
}

function rejectsAnInterceptorWithAMisspelledMethod(): void {
  // @ts-expect-error Interceptor only marks classes whose instances implement intercept().
  @Interceptor({ marker: Audited })
  class Typo {
    async intercpet<R>(
      _context: MethodInvocationContext<{ label: string }>,
      next: () => Promise<R>,
    ): Promise<R> {
      return await next();
    }
  }
  void Typo;
}

function rejectsAnInterceptorWhoseMarkerValueTypeDisagrees(): void {
  // @ts-expect-error The marker declares { label: string }; this interceptor reads { tag: number }.
  @Interceptor({ marker: Audited })
  class Mismatched implements MethodInterceptor<{ tag: number }> {
    async intercept<R>(
      _context: MethodInvocationContext<{ tag: number }>,
      next: () => Promise<R>,
    ): Promise<R> {
      return await next();
    }
  }
  void Mismatched;
}

function rejectsAPassThroughInterceptorThatFabricatesAReturnValue(): void {
  class Fallback implements MethodInterceptor<{ label: string }> {
    async intercept<R>(
      _context: MethodInvocationContext<{ label: string }>,
      _next: () => Promise<R>,
    ): Promise<R> {
      // @ts-expect-error A pass-through interceptor cannot produce an R of its own.
      return undefined;
    }
  }
  void Fallback;
}

function rejectsAFieldFormThatReadsAnUndeclaredMarkerKey(): void {
  @Interceptor({ marker: Audited })
  class FieldProbe {
    readonly intercept: InterceptHandle<{ label: string }> = async (context, next) => {
      // @ts-expect-error context.value is contextually typed as { label: string }.
      void context.value.nope;
      return await next();
    };
  }
  void FieldProbe;
}

describe("interceptor role contracts", () => {
  test("the decorator is a runtime no-op; every constraint above is discharged by typecheck", () => {
    expect(acceptsThePassThroughMethodForm()).toBeUndefined();
    expect(acceptsTheReplacingMethodForm()).toBeUndefined();
    expect(acceptsTheFieldFormWithZeroParameterAnnotations()).toBeUndefined();
    expect(rejectsAnInterceptorWithAMisspelledMethod()).toBeUndefined();
    expect(rejectsAnInterceptorWhoseMarkerValueTypeDisagrees()).toBeUndefined();
    expect(rejectsAPassThroughInterceptorThatFabricatesAReturnValue()).toBeUndefined();
    expect(rejectsAFieldFormThatReadsAnUndeclaredMarkerKey()).toBeUndefined();
  });
});
