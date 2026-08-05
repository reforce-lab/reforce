import type { Current } from "@reforce/context";
import {
  classBean,
  createApplicationContext,
  type GeneratedApplicationDefinition,
  type GeneratedResolver,
  type GeneratedSourceReference,
} from "@reforce/context/generated-runtime";
import { describe, expect, test } from "vitest";
import type { WebApplication, WebApplicationHandle, WebEngineAdapter } from "@/adapter";
import type { GeneratedRouteTable } from "@/generated-runtime";
import { createWebApplication, type RequestContext } from "@/index";

// 跨包全链路（ADR 0006 W1/W4/W7，#152）：真实 @reforce/context 运行时 + 引擎无关执行层 +
// 契约的最小假适配器，走通"启动时一次性消费路由表 → 每请求开作用域并播种根请求 bean →
// 洋葱链 → Current 句柄取请求态 → 错误处理器兜底"的完整闭环。真实引擎适配是 #153。

function sourceOf(name: string): GeneratedSourceReference {
  return {
    file: `src/${name}.ts`,
    start: { offset: 0, line: 0, character: 0 },
    end: { offset: name.length, line: 0, character: name.length },
  };
}

class RequestHolder {
  constructor(readonly requestId: string) {}
}

class Greeter {
  constructor(readonly holder: Current<RequestHolder>) {}

  greet(): { readonly greeting: string } {
    return { greeting: `hello ${this.holder.get().requestId}` };
  }

  explode(): Response {
    throw new Error("handler exploded");
  }
}

class TraceMiddleware {
  readonly seen: string[] = [];

  async handle(context: RequestContext, next: () => Promise<Response>): Promise<Response> {
    this.seen.push(`before:${context.path}`);
    const response = await next();
    this.seen.push(`after:${response.status}`);
    return response;
  }
}

class TeapotErrorHandler {
  handle(): Response {
    return new Response("teapot", { status: 418 });
  }
}

function applicationDefinition(): GeneratedApplicationDefinition {
  return {
    schemaVersion: 4,
    configs: [],
    registrations: [
      classBean({
        id: "src/request-holder.ts#RequestHolder",
        source: sourceOf("request-holder"),
        scope: "request",
        target: RequestHolder,
        dependencies: [],
        create: () => new RequestHolder("unseeded"),
        hooks: {},
      }),
      classBean({
        id: "src/greeter.ts#Greeter",
        source: sourceOf("greeter"),
        target: Greeter,
        dependencies: [
          {
            parameterIndex: 0,
            targetId: "src/request-holder.ts#RequestHolder",
            mode: "current",
            source: sourceOf("greeter-parameter-0"),
          },
        ],
        create: (resolver: GeneratedResolver) => new Greeter(resolver.current(0)),
        hooks: {},
      }),
      classBean({
        id: "src/trace-middleware.ts#TraceMiddleware",
        source: sourceOf("trace-middleware"),
        target: TraceMiddleware,
        dependencies: [],
        create: () => new TraceMiddleware(),
        hooks: {},
      }),
      classBean({
        id: "src/teapot-error-handler.ts#TeapotErrorHandler",
        source: sourceOf("teapot-error-handler"),
        target: TeapotErrorHandler,
        dependencies: [],
        create: () => new TeapotErrorHandler(),
        hooks: {},
      }),
    ],
    plans: {
      constructionOrder: [
        "src/greeter.ts#Greeter",
        "src/teapot-error-handler.ts#TeapotErrorHandler",
        "src/trace-middleware.ts#TraceMiddleware",
      ],
      requestConstructionOrder: ["src/request-holder.ts#RequestHolder"],
      startActionOrder: [],
      cleanupActionOrder: [],
    },
  };
}

function routeTable(): GeneratedRouteTable {
  return {
    schemaVersion: 1,
    routes: [
      {
        method: "GET",
        path: "/greet",
        controller: Greeter,
        beanId: "src/greeter.ts#Greeter",
        handler: "greet",
        invoke: (instance, context) => Reflect.apply(Greeter.prototype.greet, instance, [context]),
        middleware: [
          {
            bean: TraceMiddleware,
            beanId: "src/trace-middleware.ts#TraceMiddleware",
            phase: "observability",
            order: 0,
            mount: "global",
          },
        ],
        meta: {},
        schemas: {
          response: {
            "~standard": {
              version: 1,
              vendor: "reforce-test",
              validate: (value) => ({ value }),
            },
          },
        },
      },
      {
        method: "GET",
        path: "/explode",
        controller: Greeter,
        beanId: "src/greeter.ts#Greeter",
        handler: "explode",
        invoke: (instance, context) =>
          Reflect.apply(Greeter.prototype.explode, instance, [context]),
        middleware: [],
        meta: {},
        schemas: {},
      },
    ],
    errorHandlers: [
      {
        bean: TeapotErrorHandler,
        beanId: "src/teapot-error-handler.ts#TeapotErrorHandler",
        order: 0,
      },
    ],
  };
}

// 契约的最小实现：启动时一次性把 PreparedRoute 收进查找表，热路径只调用 handle。
class FakeAdapter implements WebEngineAdapter {
  readonly name = "fake";
  private readonly byKey = new Map<string, WebApplication["routes"][number]>();

  start(application: WebApplication): WebApplicationHandle {
    for (const route of application.routes) {
      this.byKey.set(`${route.method} ${route.path}`, route);
    }
    return { close: () => Promise.resolve() };
  }

  dispatch(
    method: string,
    path: string,
    request: Request,
    params: Readonly<Record<string, string>>,
  ): Promise<Response> {
    const route = this.byKey.get(`${method} ${path}`);
    if (route === undefined) {
      throw new Error(`No route registered for ${method} ${path}`);
    }
    return route.handle(request, params);
  }
}

async function startedApplication() {
  const context = createApplicationContext(applicationDefinition());
  await context.start();
  const application = createWebApplication({
    table: routeTable(),
    context,
    requestSeeds: (request) => [
      {
        target: RequestHolder,
        instance: new RequestHolder(request.headers.get("x-request-id") ?? "anonymous"),
      },
    ],
  });
  const adapter = new FakeAdapter();
  await adapter.start(application);
  return { context, adapter };
}

describe("web application over the real context runtime", () => {
  test("a request flows through scope seeding, the onion chain, Current, and serialization", async () => {
    const { context, adapter } = await startedApplication();
    const trace = context.get(TraceMiddleware);

    const response = await adapter.dispatch(
      "GET",
      "/greet",
      new Request("https://reforce.test/greet", { headers: { "x-request-id": "r-1" } }),
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ greeting: "hello r-1" });
    expect(trace.seen).toEqual(["before:/greet", "after:200"]);
    await context.close();
  });

  test("two sequential requests observe their own seeded request Beans", async () => {
    const { context, adapter } = await startedApplication();

    const first = await adapter.dispatch(
      "GET",
      "/greet",
      new Request("https://reforce.test/greet", { headers: { "x-request-id": "r-1" } }),
      {},
    );
    const second = await adapter.dispatch(
      "GET",
      "/greet",
      new Request("https://reforce.test/greet", { headers: { "x-request-id": "r-2" } }),
      {},
    );

    expect(await first.json()).toEqual({ greeting: "hello r-1" });
    expect(await second.json()).toEqual({ greeting: "hello r-2" });
    await context.close();
  });

  test("a handler error is taken over by the registered error handler", async () => {
    const { context, adapter } = await startedApplication();

    const response = await adapter.dispatch(
      "GET",
      "/explode",
      new Request("https://reforce.test/explode"),
      {},
    );

    expect(response.status).toBe(418);
    expect(await response.text()).toBe("teapot");
    await context.close();
  });
});
