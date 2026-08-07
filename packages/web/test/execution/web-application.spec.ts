import type {
  ApplicationContext,
  BeanClass,
  BeanDefinition,
  RequestScopeSeed,
} from "@reforce/core";
import { describe, expect, test } from "vitest";
import { InvalidRouteTableError, MiddlewareReenteredError } from "@/errors";
import type { RequestContext } from "@/execution/request-context";
import { WebRequestFields } from "@/execution/request-fields";
import { createWebApplication } from "@/execution/web-application";
import type { GeneratedRoute, GeneratedRouteTable } from "@/generated/route-table";
import type { RouteMiddleware } from "@/routing/middleware";
import { schemaOf } from "../support/schemas";

// 单测层把 ApplicationContext 收窄为纯查表替身（跨包运行时属外部边界）；真实 context 的
// 全链路（请求作用域、Current 句柄）由 it/web-application.spec.ts 覆盖。
function contextOf(beans: readonly (readonly [BeanClass, object])[]): ApplicationContext {
  const byTarget = new Map<unknown, object>(beans);
  return {
    start: () => Promise.resolve({ beanTimings: [] }),
    get<T extends object>(target: BeanClass<T> | BeanDefinition<T>): T {
      const instance = byTarget.get(target);
      if (instance === undefined) {
        throw new Error(`Missing test Bean for ${String(target)}`);
      }
      // 查表替身按注册键取值，泛型键值关联由用例自己维护 // justified: 测试替身的查表窄化
      return instance as T;
    },
    async runInRequestScope<R>(
      _seeds: readonly RequestScopeSeed[],
      callback: () => R,
    ): Promise<Awaited<R>> {
      return await callback();
    },
    close: () => Promise.resolve(),
  };
}

class ProbeController {
  handled: RequestContext | undefined;

  list(context: RequestContext): Response {
    this.handled = context;
    return new Response("handled");
  }
}

function routeOf(overrides: Partial<GeneratedRoute>): GeneratedRoute {
  return {
    method: "GET",
    path: "/probe",
    controller: ProbeController,
    beanId: "src/probe.ts#ProbeController",
    handler: "list",
    invoke: (instance, context) =>
      Reflect.apply(ProbeController.prototype.list, instance, [context]),
    middleware: [],
    meta: {},
    slots: [],
    response: { kind: "passthrough" },
    ...overrides,
  };
}

function tableOf(
  routes: readonly GeneratedRoute[],
  errorHandlers: GeneratedRouteTable["errorHandlers"] = [],
): GeneratedRouteTable {
  return { schemaVersion: 3, routes, errorHandlers };
}

function recordingMiddleware(log: string[], label: string): new () => RouteMiddleware {
  return class {
    async handle(_context: RequestContext, next: () => Promise<Response>): Promise<Response> {
      log.push(`${label}:before`);
      const response = await next();
      log.push(`${label}:after`);
      return response;
    }
  };
}

describe("createWebApplication onion execution", () => {
  test("runs the flattened middleware in table order around the handler", async () => {
    const log: string[] = [];
    const Outer = recordingMiddleware(log, "outer");
    const Inner = recordingMiddleware(log, "inner");
    const controller = new ProbeController();
    const application = createWebApplication({
      table: tableOf([
        routeOf({
          middleware: [
            {
              bean: Outer,
              beanId: "src/outer.ts#Outer",
              phase: "observability",
              order: 0,
              mount: "global",
            },
            {
              bean: Inner,
              beanId: "src/inner.ts#Inner",
              phase: "application",
              order: 0,
              mount: "route",
            },
          ],
        }),
      ]),
      context: contextOf([
        [ProbeController, controller],
        [Outer, new Outer()],
        [Inner, new Inner()],
      ]),
    });
    const route = application.routes[0];
    if (route === undefined) {
      throw new Error("Expected one prepared route");
    }

    const response = await route.handle(new Request("https://reforce.test/probe"), {});

    expect(await response.text()).toBe("handled");
    expect(log).toEqual(["outer:before", "inner:before", "inner:after", "outer:after"]);
  });

  test("a middleware can short-circuit without invoking the handler", async () => {
    class Deny {
      handle(): Response {
        return new Response("denied", { status: 403 });
      }
    }
    const controller = new ProbeController();
    const application = createWebApplication({
      table: tableOf([
        routeOf({
          middleware: [
            {
              bean: Deny,
              beanId: "src/deny.ts#Deny",
              phase: "admission",
              order: 0,
              mount: "global",
            },
          ],
        }),
      ]),
      context: contextOf([
        [ProbeController, controller],
        [Deny, new Deny()],
      ]),
    });
    const route = application.routes[0];
    if (route === undefined) {
      throw new Error("Expected one prepared route");
    }

    const response = await route.handle(new Request("https://reforce.test/probe"), {});

    expect(response.status).toBe(403);
    expect(controller.handled).toBeUndefined();
  });

  test("a handler error becomes a Response inside the chain, so middleware sees it", async () => {
    class Boom {
      list(): Response {
        throw new Error("boom");
      }
    }
    const seen: number[] = [];
    class Observe {
      async handle(_context: RequestContext, next: () => Promise<Response>): Promise<Response> {
        const response = await next();
        seen.push(response.status);
        return response;
      }
    }
    const application = createWebApplication({
      table: tableOf([
        routeOf({
          controller: Boom,
          beanId: "src/boom.ts#Boom",
          handler: "list",
          invoke: (instance, context) => Reflect.apply(Boom.prototype.list, instance, [context]),
          middleware: [
            {
              bean: Observe,
              beanId: "src/observe.ts#Observe",
              phase: "observability",
              order: 0,
              mount: "global",
            },
          ],
        }),
      ]),
      context: contextOf([
        [Boom, new Boom()],
        [Observe, new Observe()],
      ]),
    });
    const route = application.routes[0];
    if (route === undefined) {
      throw new Error("Expected one prepared route");
    }

    const response = await route.handle(new Request("https://reforce.test/probe"), {});

    expect(response.status).toBe(500);
    expect(seen).toEqual([500]);
  });

  // #255：重复调 next() 此前抛的是裸 Error，无码无定位——用户的错误处理器只能匹配 message
  // 字符串，而那串字符没有任何契约保证。
  test("a middleware that calls next() twice fails with a coded error naming the offending Bean", async () => {
    class DoubleNext {
      async handle(_context: RequestContext, next: () => Promise<Response>): Promise<Response> {
        await next();
        return await next();
      }
    }
    let captured: unknown;
    class Capture {
      async handle(_context: RequestContext, next: () => Promise<Response>): Promise<Response> {
        try {
          return await next();
        } catch (error) {
          captured = error;
          throw error;
        }
      }
    }
    const application = createWebApplication({
      table: tableOf([
        routeOf({
          middleware: [
            {
              bean: Capture,
              beanId: "src/capture.ts#Capture",
              phase: "application",
              order: 0,
              mount: "global",
            },
            {
              bean: DoubleNext,
              beanId: "src/double-next.ts#DoubleNext",
              phase: "application",
              order: 1,
              mount: "global",
            },
          ],
        }),
      ]),
      context: contextOf([
        [ProbeController, new ProbeController()],
        [Capture, new Capture()],
        [DoubleNext, new DoubleNext()],
      ]),
    });
    const route = application.routes[0];
    if (route === undefined) {
      throw new Error("Expected one prepared route");
    }

    await route.handle(new Request("https://reforce.test/probe"), {});

    expect(captured).toBeInstanceOf(MiddlewareReenteredError);
    expect(captured).toMatchObject({
      code: "MIDDLEWARE_REENTERED",
      beanId: "src/double-next.ts#DoubleNext",
    });
  });

  // 点名的必须是里面那个犯规的，不是外面那个守规矩的——链是嵌套的，弄反了排查方向就反了。
  test("the re-entry failure names the route it happened on", async () => {
    class DoubleNext {
      async handle(_context: RequestContext, next: () => Promise<Response>): Promise<Response> {
        await next();
        return await next();
      }
    }
    let captured: unknown;
    class Capture {
      async handle(_context: RequestContext, next: () => Promise<Response>): Promise<Response> {
        try {
          return await next();
        } catch (error) {
          captured = error;
          throw error;
        }
      }
    }
    const application = createWebApplication({
      table: tableOf([
        routeOf({
          middleware: [
            {
              bean: Capture,
              beanId: "src/capture.ts#Capture",
              phase: "application",
              order: 0,
              mount: "global",
            },
            {
              bean: DoubleNext,
              beanId: "src/double-next.ts#DoubleNext",
              phase: "application",
              order: 1,
              mount: "global",
            },
          ],
        }),
      ]),
      context: contextOf([
        [ProbeController, new ProbeController()],
        [Capture, new Capture()],
        [DoubleNext, new DoubleNext()],
      ]),
    });
    const route = application.routes[0];
    if (route === undefined) {
      throw new Error("Expected one prepared route");
    }

    await route.handle(new Request("https://reforce.test/probe"), {});

    expect(captured).toMatchObject({ method: "GET", path: "/probe" });
    expect(captured instanceof Error ? captured.message : "").toContain("GET /probe");
  });

  test("a middleware error is still converted by the outer boundary", async () => {
    class Faulty {
      handle(): Response {
        throw new Error("middleware boom");
      }
    }
    const application = createWebApplication({
      table: tableOf([
        routeOf({
          middleware: [
            {
              bean: Faulty,
              beanId: "src/faulty.ts#Faulty",
              phase: "application",
              order: 0,
              mount: "global",
            },
          ],
        }),
      ]),
      context: contextOf([
        [ProbeController, new ProbeController()],
        [Faulty, new Faulty()],
      ]),
    });
    const route = application.routes[0];
    if (route === undefined) {
      throw new Error("Expected one prepared route");
    }

    const response = await route.handle(new Request("https://reforce.test/probe"), {});

    expect(response.status).toBe(500);
  });
});

describe("createWebApplication route assembly", () => {
  test("decodes slots after middleware and before the handler", async () => {
    const order: string[] = [];
    class Observe {
      async handle(_context: RequestContext, next: () => Promise<Response>): Promise<Response> {
        order.push("middleware");
        return await next();
      }
    }
    class Echo {
      show(id: unknown): Response {
        order.push("handler");
        return new Response(JSON.stringify({ id: String(id) }));
      }
    }
    const application = createWebApplication({
      table: tableOf([
        routeOf({
          controller: Echo,
          beanId: "src/echo.ts#Echo",
          handler: "show",
          invoke: (instance, _context, slots) =>
            Reflect.apply(Echo.prototype.show, instance, [slots[0]]),
          middleware: [
            {
              bean: Observe,
              beanId: "src/observe.ts#Observe",
              phase: "observability",
              order: 0,
              mount: "global",
            },
          ],
          slots: [
            {
              slot: "param",
              key: "id",
              decode: schemaOf((value) => {
                order.push("decode");
                return { value: Reflect.get(Object(value), "id") };
              }),
            },
          ],
        }),
      ]),
      context: contextOf([
        [Echo, new Echo()],
        [Observe, new Observe()],
      ]),
    });
    const route = application.routes[0];
    if (route === undefined) {
      throw new Error("Expected one prepared route");
    }

    const response = await route.handle(new Request("https://reforce.test/probe"), { id: "1" });

    expect(order).toEqual(["middleware", "decode", "handler"]);
    expect(await response.json()).toEqual({ id: "1" });
  });

  test("a slot decode failure answers 400 without reaching the handler", async () => {
    const controller = new ProbeController();
    const application = createWebApplication({
      table: tableOf([
        routeOf({
          slots: [
            {
              slot: "query",
              key: "page",
              decode: schemaOf(() => ({ issues: [{ message: "page must be a number" }] })),
            },
          ],
        }),
      ]),
      context: contextOf([[ProbeController, controller]]),
    });
    const route = application.routes[0];
    if (route === undefined) {
      throw new Error("Expected one prepared route");
    }

    const response = await route.handle(new Request("https://reforce.test/probe?page=x"), {});

    expect(response.status).toBe(400);
    expect(controller.handled).toBeUndefined();
    expect(await response.json()).toMatchObject({
      source: "query",
      issues: [{ message: "page must be a number" }],
    });
  });

  test("rejects a middleware Bean that does not implement handle()", () => {
    class NotMiddleware {}
    const table = tableOf([
      routeOf({
        middleware: [
          {
            // 用例故意破坏类型契约，验证运行时复检兜底 // justified: 负向测试输入
            bean: NotMiddleware as unknown as BeanClass<RouteMiddleware>,
            beanId: "src/not.ts#NotMiddleware",
            phase: "application",
            order: 0,
            mount: "global",
          },
        ],
      }),
    ]);

    expect(() =>
      createWebApplication({
        table,
        context: contextOf([
          [ProbeController, new ProbeController()],
          [NotMiddleware, new NotMiddleware()],
        ]),
      }),
    ).toThrow(InvalidRouteTableError);
  });

  test("rejects a table with an unknown schema version", () => {
    expect(() =>
      createWebApplication({
        table: { schemaVersion: 1, routes: [], errorHandlers: [] },
        context: contextOf([]),
      }),
    ).toThrow(InvalidRouteTableError);
  });
});

// —— 响应编码与响应头合并(RFC 0012 S2,#274) ——

describe("createWebApplication response encoding", () => {
  class PlainReturn {
    show(): { readonly id: bigint; readonly secret?: string } {
      return { id: 42n, secret: "drop me" };
    }
  }

  function plainRoute(overrides: Partial<GeneratedRoute>): GeneratedRoute {
    return routeOf({
      controller: PlainReturn,
      beanId: "src/plain.ts#PlainReturn",
      handler: "show",
      invoke: (instance) => Reflect.apply(PlainReturn.prototype.show, instance, []),
      ...overrides,
    });
  }

  function preparedWith(overrides: Partial<GeneratedRoute>) {
    const application = createWebApplication({
      table: tableOf([plainRoute(overrides)]),
      context: contextOf([[PlainReturn, new PlainReturn()]]),
    });
    const route = application.routes[0];
    if (route === undefined) {
      throw new Error("Expected one prepared route");
    }
    return route;
  }

  test("a plain return value goes through the route encoder before serialization", async () => {
    const route = preparedWith({
      response: {
        kind: "table",
        status: 200,
        encode: (value) => ({ id: String(Reflect.get(Object(value), "id")) }),
      },
    });

    const response = await route.handle(new Request("https://reforce.test/probe"), {});

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "42" });
  });

  // passthrough 路由(直返 Response 的声明)返回普通对象:500 语义不变(#275)。
  test("a plain return value on a passthrough route becomes a 500", async () => {
    const route = preparedWith({});

    const response = await route.handle(new Request("https://reforce.test/probe"), {});

    expect(response.status).toBe(500);
  });

  // 降级路由(#275):free-form 原样序列化,不投影。
  test("a free-form route serializes the raw value with its declared status", async () => {
    const route = preparedWith({ response: { kind: "free-form", status: 200 } });

    const response = await route.handle(new Request("https://reforce.test/probe"), {});

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "42", secret: "drop me" });
  });
});

describe("createWebApplication response header merging", () => {
  class HeaderWriter {
    plain(context: RequestContext): { readonly ok: boolean } {
      context.responseHeaders.set("x-request-id", "abc");
      context.responseHeaders.append("set-cookie", "a=1");
      context.responseHeaders.append("set-cookie", "b=2");
      return { ok: true };
    }

    raw(context: RequestContext): Response {
      context.responseHeaders.set("x-request-id", "abc");
      return new Response("raw");
    }

    failing(context: RequestContext): never {
      context.responseHeaders.set("x-request-id", "abc");
      throw new Error("boom");
    }
  }

  function preparedFor(handler: "plain" | "raw" | "failing", encode?: (value: unknown) => unknown) {
    const application = createWebApplication({
      table: tableOf([
        routeOf({
          controller: HeaderWriter,
          beanId: "src/header-writer.ts#HeaderWriter",
          handler,
          invoke: (instance, context) =>
            Reflect.apply(HeaderWriter.prototype[handler], instance, [context]),
          ...(encode === undefined
            ? {}
            : { response: { kind: "table", status: 200, encode } as const }),
        }),
      ]),
      context: contextOf([[HeaderWriter, new HeaderWriter()]]),
    });
    const route = application.routes[0];
    if (route === undefined) {
      throw new Error("Expected one prepared route");
    }
    return route;
  }

  test("merges context response headers into an encoded response, set-cookie one per line", async () => {
    const route = preparedFor("plain", (value) => value);

    const response = await route.handle(new Request("https://reforce.test/probe"), {});

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("abc");
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    // 序列化默认头不因合并丢失。
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  // 逃生口不碰:handler 直接返回的 Response 是用户全权掌控的出口。
  test("leaves a handler-returned Response without the context headers", async () => {
    const route = preparedFor("raw");

    const response = await route.handle(new Request("https://reforce.test/probe"), {});

    expect(await response.text()).toBe("raw");
    expect(response.headers.get("x-request-id")).toBeNull();
  });

  // 错误响应由错误分派统一负责,handler 半路写下的头不跟着错误出线。
  test("leaves an error response without the context headers", async () => {
    const route = preparedFor("failing", (value) => value);

    const response = await route.handle(new Request("https://reforce.test/probe"), {});

    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBeNull();
  });
});

// L4（RFC 0011，#242 影响面：「@reforce/web：请求字段的 LogFieldSource 实现」）。在它存在
// 之前，请求期间应用打的每一条日志都看不出是哪个请求触发的——请求完成时那条记录有
// method/path，但那是另一条记录，靠时间戳去拼是猜。
describe("WebRequestFields", () => {
  test("reports no fields outside a request", () => {
    expect(new WebRequestFields().fields()).toBeUndefined();
  });

  test("a handler running inside a request sees that request's method and path", async () => {
    const source = new WebRequestFields();
    let seen: unknown;
    class Peeking {
      list(): Response {
        seen = source.fields();
        return new Response("ok");
      }
    }
    const application = createWebApplication({
      table: tableOf([
        routeOf({
          method: "POST",
          path: "/orders/:id",
          controller: Peeking,
          invoke: (instance) => Reflect.apply(Peeking.prototype.list, instance, []),
        }),
      ]),
      context: contextOf([[Peeking, new Peeking()]]),
    });
    const route = application.routes[0];
    if (route === undefined) {
      throw new Error("Expected one prepared route");
    }

    await route.handle(new Request("https://reforce.test/orders/42", { method: "POST" }), {
      id: "42",
    });

    // path 是编译期的路由模式而不是 /orders/42：字段要能聚合，具体路径基数无界。
    expect(seen).toEqual({ method: "POST", path: "/orders/:id" });
  });

  // ALS 只向内传播，所以请求结束后必须什么都读不到——否则串成一条「上一个请求的 path」
  // 挂在与请求无关的日志上，比没有字段更误导。
  test("the fields are gone again once the request has finished", async () => {
    const source = new WebRequestFields();
    const application = createWebApplication({
      table: tableOf([routeOf({})]),
      context: contextOf([[ProbeController, new ProbeController()]]),
    });
    const route = application.routes[0];
    if (route === undefined) {
      throw new Error("Expected one prepared route");
    }

    await route.handle(new Request("https://reforce.test/probe"), {});

    expect(source.fields()).toBeUndefined();
  });
});
