import { describe, expect, test } from "vitest";
import type { RequestContext } from "@/execution/request-context";
import { ErrorHandler, Middleware, Use } from "@/routing/decorators";
import type { ErrorHandlerHandle, MiddlewareHandle, RouteErrorHandler } from "@/routing/middleware";

// 角色契约的类型层证据（ADR 0006 W4）：@Middleware / @ErrorHandler / @Use 的形状约束只在
// typecheck 阶段有效，运行时装饰器是 no-op。这些用例靠 @ts-expect-error 断言——指令没被
// 触发时 tsc 反过来报 "unused directive"，因此 packages/web 的 typecheck 就是它们的裁判
// （context/it/public-api.spec.ts 同款做法，Issue #106）。

class Guard {
  handle(context: RequestContext, next: () => Promise<Response>): Promise<Response> {
    void context;
    return next();
  }
}

function rejectsAMiddlewareWithAMisspelledHandle(): void {
  // @ts-expect-error Middleware only marks classes whose instances implement handle().
  @Middleware()
  class Typo {
    hanlde(context: RequestContext, next: () => Promise<Response>): Promise<Response> {
      void context;
      return next();
    }
  }
  void Typo;
}

function rejectsAMiddlewareWhoseHandleReturnsTheWrongType(): void {
  // @ts-expect-error handle() must resolve to a Response, not to a string.
  @Middleware()
  class WrongReturn {
    handle(context: RequestContext, next: () => Promise<Response>): string {
      void context;
      void next;
      return "not a response";
    }
  }
  void WrongReturn;
}

function rejectsAnErrorHandlerWithTheMiddlewareShape(): void {
  // @ts-expect-error An error handler receives (error, context), not (context, next).
  @ErrorHandler()
  class Mismatched {
    handle(context: RequestContext, next: () => Promise<Response>): Promise<Response> {
      void context;
      return next();
    }
  }
  void Mismatched;
}

function rejectsUseOnAClassThatIsNotMiddleware(): void {
  class PlainService {
    label(): string {
      return "plain";
    }
  }
  // @ts-expect-error Use only mounts classes whose instances implement the onion contract.
  @Use(PlainService)
  class Controllerish {}
  void Controllerish;
}

function acceptsTheFieldFormWithZeroParameterAnnotations(): void {
  @Middleware({ phase: "admission" })
  class FieldGuard {
    // 上下文类型位置：参数类型由 MiddlewareHandle 推导，写法上零标注。
    readonly handle: MiddlewareHandle = (context, next) => {
      void context.path;
      return next();
    };
  }

  @ErrorHandler()
  class FieldRecovery {
    readonly handle: ErrorHandlerHandle = (error, context) => {
      void error;
      void context.path;
      return new Response("recovered");
    };
  }

  void FieldGuard;
  void FieldRecovery;
}

void rejectsAMiddlewareWithAMisspelledHandle;
void rejectsAMiddlewareWhoseHandleReturnsTheWrongType;
void rejectsAnErrorHandlerWithTheMiddlewareShape;
void rejectsUseOnAClassThatIsNotMiddleware;
void acceptsTheFieldFormWithZeroParameterAnnotations;

describe("role decorators stay runtime no-ops while tightening types", () => {
  test("a middleware class keeps its identity and behavior", () => {
    @Middleware({ phase: "admission" })
    class DecoratedGuard extends Guard {}

    const guard = new DecoratedGuard();

    expect(guard).toBeInstanceOf(Guard);
  });

  test("the field form satisfies the onion contract the runtime probes for", async () => {
    @Middleware()
    class FieldGuard {
      readonly handle: MiddlewareHandle = (context, next) => {
        void context;
        return next();
      };
    }

    const guard: RouteErrorHandler | FieldGuard = new FieldGuard();

    expect(typeof Reflect.get(guard, "handle")).toBe("function");
    await expect(
      new FieldGuard().handle({} as RequestContext, async () => new Response("inner")),
    ).resolves.toBeInstanceOf(Response);
  });
});
