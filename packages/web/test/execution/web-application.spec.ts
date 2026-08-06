import type {
  ApplicationContext,
  BeanClass,
  BeanDefinition,
  RequestScopeSeed,
} from "@reforce/core";
import { describe, expect, test } from "vitest";
import { InvalidRouteTableError } from "@/errors";
import type { RequestContext } from "@/execution/request-context";
import { createWebApplication } from "@/execution/web-application";
import type { GeneratedRoute, GeneratedRouteTable } from "@/generated/route-table";
import type { RouteMiddleware } from "@/routing/middleware";
import { schemaOf } from "../support/schemas";

// 单测层把 ApplicationContext 收窄为纯查表替身（跨包运行时属外部边界）；真实 context 的
// 全链路（请求作用域、Current 句柄）由 it/web-application.spec.ts 覆盖。
function contextOf(beans: readonly (readonly [BeanClass, object])[]): ApplicationContext {
  const byTarget = new Map<unknown, object>(beans);
  return {
    start: () => Promise.resolve(),
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
    schemas: {},
    ...overrides,
  };
}

function tableOf(
  routes: readonly GeneratedRoute[],
  errorHandlers: GeneratedRouteTable["errorHandlers"] = [],
): GeneratedRouteTable {
  return { schemaVersion: 1, routes, errorHandlers };
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
  test("validates request inputs after middleware and before the handler", async () => {
    const order: string[] = [];
    class Observe {
      async handle(_context: RequestContext, next: () => Promise<Response>): Promise<Response> {
        order.push("middleware");
        return await next();
      }
    }
    class Echo {
      show(context: RequestContext): Response {
        order.push("handler");
        return new Response(JSON.stringify(context.params));
      }
    }
    const application = createWebApplication({
      table: tableOf([
        routeOf({
          controller: Echo,
          beanId: "src/echo.ts#Echo",
          handler: "show",
          invoke: (instance, context) => Reflect.apply(Echo.prototype.show, instance, [context]),
          middleware: [
            {
              bean: Observe,
              beanId: "src/observe.ts#Observe",
              phase: "observability",
              order: 0,
              mount: "global",
            },
          ],
          schemas: {
            params: schemaOf((value) => {
              order.push("validate");
              return { value };
            }),
          },
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

    await route.handle(new Request("https://reforce.test/probe"), { id: "1" });

    expect(order).toEqual(["middleware", "validate", "handler"]);
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
        table: { schemaVersion: 2, routes: [], errorHandlers: [] },
        context: contextOf([]),
      }),
    ).toThrow(InvalidRouteTableError);
  });
});
