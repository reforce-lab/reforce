import type {
  ApplicationContext,
  BeanClass,
  BeanDefinition,
  RequestScopeSeed,
} from "@reforce/core";
import { describe, expect, test } from "vitest";
import { InvalidRouteTableError, MiddlewareReenteredError } from "@/errors";
import type { RequestContext } from "@/execution/request-context";
import { currentRequestId, WebRequestFields } from "@/execution/request-fields";
import type { RouteResponse } from "@/execution/route-response";
import { createWebApplication, type RequestLogger } from "@/execution/web-application";
import type { GeneratedRoute, GeneratedRouteTable } from "@/generated/route-table";
import type { RouteMiddleware } from "@/routing/middleware";
import { readRouteBody, readRouteJson } from "../support/route-response";
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
  return { schemaVersion: 4, routes, errorHandlers };
}

function recordingMiddleware(log: string[], label: string): new () => RouteMiddleware {
  return class {
    async handle(
      _context: RequestContext,
      next: () => Promise<RouteResponse>,
    ): Promise<RouteResponse> {
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

    expect(await readRouteBody(response)).toBe("handled");
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
      async handle(
        _context: RequestContext,
        next: () => Promise<RouteResponse>,
      ): Promise<RouteResponse> {
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
      async handle(
        _context: RequestContext,
        next: () => Promise<RouteResponse>,
      ): Promise<RouteResponse> {
        await next();
        return await next();
      }
    }
    let captured: unknown;
    class Capture {
      async handle(
        _context: RequestContext,
        next: () => Promise<RouteResponse>,
      ): Promise<RouteResponse> {
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
      async handle(
        _context: RequestContext,
        next: () => Promise<RouteResponse>,
      ): Promise<RouteResponse> {
        await next();
        return await next();
      }
    }
    let captured: unknown;
    class Capture {
      async handle(
        _context: RequestContext,
        next: () => Promise<RouteResponse>,
      ): Promise<RouteResponse> {
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
      async handle(
        _context: RequestContext,
        next: () => Promise<RouteResponse>,
      ): Promise<RouteResponse> {
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
    expect(await readRouteJson(response)).toEqual({ id: "1" });
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
    expect(await readRouteJson(response)).toMatchObject({
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
    expect(await readRouteJson(response)).toEqual({ id: "42" });
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
    expect(await readRouteJson(response)).toEqual({ id: "42", secret: "drop me" });
  });
});

describe("createWebApplication response header merging", () => {
  class HeaderWriter {
    plain(context: RequestContext): { readonly ok: boolean } {
      context.responseHeaders.set("x-audit-id", "abc");
      context.responseHeaders.append("set-cookie", "a=1");
      context.responseHeaders.append("set-cookie", "b=2");
      return { ok: true };
    }

    raw(context: RequestContext): Response {
      context.responseHeaders.set("x-audit-id", "abc");
      return new Response("raw");
    }

    failing(context: RequestContext): never {
      context.responseHeaders.set("x-audit-id", "abc");
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
    expect(response.headers.get("x-audit-id")).toBe("abc");
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    // 序列化默认头不因合并丢失。
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  // #340 决议 2 把这条规则反了过来：响应头收成单一通道之后，写在 context 上的头**一定**出站，
  // 逃生口不再例外。此前的例外（RFC 0012 S3 / #275 拍板 3「不碰 handler 直接返回的 Response」）
  // 随 mergeResponseHeaders 一起作废——一条无例外的规则胜过一条带例外的。
  test("applies the context headers to a handler-returned Response too", async () => {
    const route = preparedFor("raw");

    const response = await route.handle(new Request("https://reforce.test/probe"), {});

    expect(await readRouteBody(response)).toBe("raw");
    expect(response.headers.get("x-audit-id")).toBe("abc");
  });

  // 同上：错误响应此前也在例外之列，现在同样出站。代价明写在这里——handler 在抛错之前写下的
  // 头会跟着 500 一起出线。这是决议接受的行为变化，不是回归。
  test("applies the context headers to an error response too", async () => {
    const route = preparedFor("failing", (value) => value);

    const response = await route.handle(new Request("https://reforce.test/probe"), {});

    expect(response.status).toBe(500);
    expect(response.headers.get("x-audit-id")).toBe("abc");
    // 错误分派的 content-type 压过 handler 半路写的序列化默认值。
    expect(response.headers.get("content-type")).toBe("application/problem+json");
  });
});

// L4（RFC 0011，#242 影响面：「@reforce/web-core：请求字段的 LogFieldSource 实现」）。在它存在
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
    // requestId 是 #303 的第三元组成员,与响应头同值。
    expect(seen).toEqual({
      method: "POST",
      path: "/orders/:id",
      requestId: expect.any(String),
    });
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

// request id 开箱件(#303):零配置内建行为——回显/生成、全部出口盖章、L6 与响应头恒等、
// seeder 可读、immutable headers 不破 handle 契约。引擎级 404 不进 handle,天然在边界外。
describe("createWebApplication request id", () => {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  class Outcomes {
    ok(): Response {
      return new Response("ok");
    }

    encoded(): { readonly ok: boolean } {
      return { ok: true };
    }

    failing(): never {
      throw new Error("boom");
    }
  }

  function preparedOutcome(
    overrides: Partial<GeneratedRoute>,
    options: {
      readonly middleware?: GeneratedRoute["middleware"];
      readonly logger?: RequestLogger;
    } = {},
  ) {
    const application = createWebApplication({
      table: tableOf([
        routeOf({
          controller: Outcomes,
          beanId: "src/outcomes.ts#Outcomes",
          ...(options.middleware === undefined ? {} : { middleware: options.middleware }),
          ...overrides,
        }),
      ]),
      context: contextOf([
        [Outcomes, new Outcomes()],
        ...(options.middleware ?? []).map(
          (entry) => [entry.bean, new (entry.bean as new () => object)()] as const,
        ),
      ]),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    const route = application.routes[0];
    if (route === undefined) {
      throw new Error("Expected one prepared route");
    }
    return route;
  }

  function invokeOf(handler: "ok" | "encoded" | "failing"): Partial<GeneratedRoute> {
    return {
      handler,
      invoke: (instance) => Reflect.apply(Outcomes.prototype[handler], instance, []),
    };
  }

  test("echoes a legal client id and regenerates an illegal one", async () => {
    const route = preparedOutcome(invokeOf("ok"));

    const echoed = await route.handle(
      new Request("https://reforce.test/probe", { headers: { "x-request-id": "client-1" } }),
      {},
    );
    expect(echoed.headers.get("x-request-id")).toBe("client-1");

    const regenerated = await route.handle(
      new Request("https://reforce.test/probe", { headers: { "x-request-id": "has space" } }),
      {},
    );
    expect(regenerated.headers.get("x-request-id")).toMatch(uuidPattern);
  });

  test("stamps every exit: raw Response, encoded response, validation 400 and fallback 500", async () => {
    const cases: readonly Partial<GeneratedRoute>[] = [
      invokeOf("ok"),
      {
        ...invokeOf("encoded"),
        response: { kind: "table", status: 200, encode: (value) => value },
      },
      {
        ...invokeOf("encoded"),
        slots: [
          {
            slot: "query",
            key: "page",
            decode: schemaOf(() => ({ issues: [{ message: "page must be a number" }] })),
          },
        ],
      },
      invokeOf("failing"),
    ];
    for (const overrides of cases) {
      const route = preparedOutcome(overrides);
      const response = await route.handle(
        new Request("https://reforce.test/probe?page=x", {
          headers: { "x-request-id": "stamp-me" },
        }),
        {},
      );
      expect(response.headers.get("x-request-id")).toBe("stamp-me");
    }
  });

  // 任何中间件都盖不到这条路径:中间件自身抛错的外层兜底响应,只有统一缝能盖章。
  test("stamps the outer fallback when a middleware itself throws", async () => {
    class Exploding {
      handle(): Promise<Response> {
        throw new Error("middleware exploded");
      }
    }
    const route = preparedOutcome(invokeOf("ok"), {
      middleware: [
        {
          bean: Exploding,
          beanId: "src/exploding.ts#Exploding",
          phase: "observability",
          order: 0,
          mount: "global",
        },
      ],
    });

    const response = await route.handle(
      new Request("https://reforce.test/probe", { headers: { "x-request-id": "outer-path" } }),
      {},
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe("outer-path");
  });

  test("a user-written x-request-id header is overwritten (client-visible id ≡ log id)", async () => {
    class Spoofing {
      spoof(context: RequestContext): { readonly ok: boolean } {
        context.responseHeaders.set("x-request-id", "spoofed");
        return { ok: true };
      }
    }
    const application = createWebApplication({
      table: tableOf([
        routeOf({
          controller: Spoofing,
          beanId: "src/spoofing.ts#Spoofing",
          handler: "spoof",
          invoke: (instance, context) =>
            Reflect.apply(Spoofing.prototype.spoof, instance, [context]),
          response: { kind: "table", status: 200, encode: (value) => value },
        }),
      ]),
      context: contextOf([[Spoofing, new Spoofing()]]),
    });
    const prepared = application.routes[0];
    if (prepared === undefined) {
      throw new Error("Expected one prepared route");
    }

    const response = await prepared.handle(
      new Request("https://reforce.test/probe", { headers: { "x-request-id": "true-id" } }),
      {},
    );

    expect(response.headers.get("x-request-id")).toBe("true-id");
  });

  // 逃生口 Response 的头是被**拷贝**进框架自己那个 Headers 的，不是借用用户那个实例
  // （#340 的 absorbResponse）。所以「用户给的 Response 头不可变」这件事结构上碰不到盖章
  // 那一步——此前那道 try/catch 因此成了死代码并被删除。这条用例改为钉住新结构：即便用户
  // 交出一个 set 会抛的 Response，request id 照样盖得上。
  test("stamps the request id even when the handler returns immutable headers", async () => {
    class ImmutableReturning {
      immutable(): Response {
        const response = new Response("proxied");
        return new Proxy(response, {
          get(target, property) {
            if (property === "headers") {
              return new Proxy(target.headers, {
                get(headers, headerProperty) {
                  if (headerProperty === "set") {
                    return () => {
                      throw new TypeError("immutable headers");
                    };
                  }
                  const value = Reflect.get(headers, headerProperty, headers);
                  return typeof value === "function" ? value.bind(headers) : value;
                },
              });
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }
    }
    const application = createWebApplication({
      table: tableOf([
        routeOf({
          controller: ImmutableReturning,
          beanId: "src/immutable.ts#ImmutableReturning",
          handler: "immutable",
          invoke: (instance) => Reflect.apply(ImmutableReturning.prototype.immutable, instance, []),
        }),
      ]),
      context: contextOf([[ImmutableReturning, new ImmutableReturning()]]),
    });
    const prepared = application.routes[0];
    if (prepared === undefined) {
      throw new Error("Expected one prepared route");
    }

    const response = await prepared.handle(new Request("https://reforce.test/probe"), {});

    expect(await readRouteBody(response)).toBe("proxied");
    // 旧实现在这里盖不上章（用户 Response 的 headers.set 抛，被 try/catch 吞掉），断言是
    // toBeNull()。#340 之后头是拷进框架自己那份的，不变量「客户端可见 id ≡ 日志 id」因此
    // 在这条路径上也真正成立。
    expect(response.headers.get("x-request-id")).not.toBeNull();
  });

  test("the L6 request record carries the same id the response header shows", async () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const logger: RequestLogger = {
      isEnabled: () => true,
      info: (fields) => {
        if (fields !== undefined) {
          records.push(fields);
        }
      },
      warn: () => undefined,
      error: () => undefined,
    };
    const route = preparedOutcome(invokeOf("ok"), { logger });

    const response = await route.handle(
      new Request("https://reforce.test/probe", { headers: { "x-request-id": "log-me" } }),
      {},
    );

    expect(response.headers.get("x-request-id")).toBe("log-me");
    expect(records).toHaveLength(1);
    expect(records[0]?.requestId).toBe("log-me");
  });

  test("a request seeder can read currentRequestId", async () => {
    let seen: string | undefined;
    const application = createWebApplication({
      table: tableOf([
        routeOf({ controller: Outcomes, beanId: "src/outcomes.ts#Outcomes", ...invokeOf("ok") }),
      ]),
      context: contextOf([[Outcomes, new Outcomes()]]),
      requestSeeds: () => {
        seen = currentRequestId();
        return [];
      },
    });
    const prepared = application.routes[0];
    if (prepared === undefined) {
      throw new Error("Expected one prepared route");
    }

    await prepared.handle(
      new Request("https://reforce.test/probe", { headers: { "x-request-id": "seeded" } }),
      {},
    );

    expect(seen).toBe("seeded");
  });
});
