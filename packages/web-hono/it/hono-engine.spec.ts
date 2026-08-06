import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { defineRouteMarker } from "@reforce/web";
import type { PreparedRoute, WebApplication } from "@reforce/web/adapter";
import type { MiddlewareHandler } from "hono";
import { describe, expect, test } from "vitest";
import {
  type HonoConfigure,
  type HonoConfigurer,
  type HonoRouteCustomize,
  type HonoRouteCustomizer,
  WebEngine,
} from "@/index";

// hono 引擎的自有面：两座桥（应用级 configurer、路由级 customizer）与 hono 特有的取舍。
// 引擎无关的契约行为由 @reforce/web/conformance 覆盖（见 it/conformance.spec.ts），这里不重复。

const RateLimit = defineRouteMarker<{ readonly max: number }>("rateLimit");

function route(
  method: PreparedRoute["method"],
  path: string,
  handle: PreparedRoute["handle"],
  meta: Readonly<Record<string, unknown>> = {},
): PreparedRoute {
  return {
    method,
    path,
    handle,
    meta: (marker) => Reflect.get(meta, marker.key) as never,
  };
}

async function withEngine(
  routes: readonly PreparedRoute[],
  run: (base: string) => Promise<void>,
  bridges: {
    readonly configurers?: readonly HonoConfigurer[];
    readonly customizers?: readonly HonoRouteCustomizer[];
  } = {},
): Promise<void> {
  const engine = new WebEngine({ port: 0 }, bridges.configurers ?? [], bridges.customizers ?? []);
  const application: WebApplication = { routes };
  const handle = await engine.start(application);
  const server = Reflect.get(engine, "server") as Server;
  const address = server.address() as AddressInfo;
  try {
    await run(`http://localhost:${address.port}`);
  } finally {
    await handle.close();
  }
}

const ping = route("GET", "/ping", () => Promise.resolve(new Response("pong")));

describe("the application-level configurer bridge", () => {
  test("a configurer installs a global hono middleware around every route", async () => {
    // 字段形态：app 自动带类型，用户不必标注——也因此 app.use 里的中间件回调参数不会连带塌成 any
    class Stamp implements HonoConfigurer {
      configure: HonoConfigure = (app) => {
        app.use("*", async (context, next) => {
          await next();
          context.res.headers.set("x-stamped", "yes");
        });
      };
    }

    await withEngine(
      [ping],
      async (base) => {
        const response = await fetch(`${base}/ping`);

        expect(response.headers.get("x-stamped")).toBe("yes");
      },
      { configurers: [new Stamp()] },
    );
  });

  test("configurers run in the order they are injected", async () => {
    const trail: string[] = [];
    const recorder = (name: string): HonoConfigurer => ({
      configure: (app) => {
        app.use("*", async (_context, next) => {
          trail.push(name);
          await next();
        });
      },
    });

    await withEngine(
      [ping],
      async (base) => {
        await fetch(`${base}/ping`);

        expect(trail).toEqual(["first", "second"]);
      },
      { configurers: [recorder("first"), recorder("second")] },
    );
  });

  test("an async configurer is awaited before any route is registered", async () => {
    class Slow implements HonoConfigurer {
      configure: HonoConfigure = async (app) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        app.use("*", async (context, next) => {
          await next();
          context.res.headers.set("x-late", "installed");
        });
      };
    }

    await withEngine(
      [ping],
      async (base) => {
        // 时序是硬约束：app.use 只对之后注册的路由生效，await 漏了就静默无效
        expect((await fetch(`${base}/ping`)).headers.get("x-late")).toBe("installed");
      },
      { configurers: [new Slow()] },
    );
  });

  test("zero configurers is legal", async () => {
    await withEngine([ping], async (base) => {
      expect(await (await fetch(`${base}/ping`)).text()).toBe("pong");
    });
  });
});

describe("the route-level customizer bridge", () => {
  test("a customizer selects one route by marker and leaves the others alone", async () => {
    const limited = route("GET", "/limited", () => Promise.resolve(new Response("limited")), {
      rateLimit: { max: 5 },
    });
    class RouteLimits implements HonoRouteCustomizer {
      // 字段形态：route 参数自动带类型
      customize: HonoRouteCustomize = (item) => {
        const limit = item.meta(RateLimit);
        if (limit === undefined) {
          return undefined;
        }
        const middleware: MiddlewareHandler = async (context, next) => {
          await next();
          context.res.headers.set("x-rate-limit", String(limit.max));
        };
        return [middleware];
      };
    }

    await withEngine(
      [ping, limited],
      async (base) => {
        expect((await fetch(`${base}/limited`)).headers.get("x-rate-limit")).toBe("5");
        expect((await fetch(`${base}/ping`)).headers.get("x-rate-limit")).toBeNull();
      },
      { customizers: [new RouteLimits()] },
    );
  });

  test("a customizer middleware can short-circuit before the reforce handler", async () => {
    let reached = false;
    const guarded = route("GET", "/guarded", () => {
      reached = true;
      return Promise.resolve(new Response("handler"));
    });

    await withEngine(
      [guarded],
      async (base) => {
        const response = await fetch(`${base}/guarded`);

        expect(response.status).toBe(403);
        expect(reached).toBe(false);
      },
      {
        customizers: [
          { customize: () => [() => Promise.resolve(new Response("denied", { status: 403 }))] },
        ],
      },
    );
  });

  test("customizer middleware nests outside the reforce handler in injection order", async () => {
    const trail: string[] = [];
    const recorder = (name: string): HonoRouteCustomizer => ({
      customize: () => [
        async (_context, next) => {
          trail.push(`${name}:in`);
          await next();
          trail.push(`${name}:out`);
        },
      ],
    });

    await withEngine(
      [
        route("GET", "/traced", () => {
          trail.push("handler");
          return Promise.resolve(new Response("ok"));
        }),
      ],
      async (base) => {
        await fetch(`${base}/traced`);

        expect(trail).toEqual(["outer:in", "inner:in", "handler", "inner:out", "outer:out"]);
      },
      { customizers: [recorder("outer"), recorder("inner")] },
    );
  });

  // 同 path 不同 method 的两条路由各自独立定制：逐条 app.on 是 method-scoped 的
  test("customizing one method does not leak onto another method on the same path", async () => {
    await withEngine(
      [
        route("GET", "/items", () => Promise.resolve(new Response("get"))),
        route("POST", "/items", () => Promise.resolve(new Response("post"))),
      ],
      async (base) => {
        expect((await fetch(`${base}/items`)).headers.get("x-only-get")).toBe("yes");
        const posted = await fetch(`${base}/items`, { method: "POST" });
        expect(posted.headers.get("x-only-get")).toBeNull();
      },
      {
        customizers: [
          {
            customize: (item) =>
              item.method === "GET"
                ? [
                    async (context, next) => {
                      await next();
                      context.res.headers.set("x-only-get", "yes");
                    },
                  ]
                : undefined,
          },
        ],
      },
    );
  });
});

// hono 把 HEAD 硬编码转成 GET（#236，hono-base 里在 router.match 之前且无 hook），绕法依赖未
// 文档化的实现，且会让 c.req.method 变成私有串导致按 method 分支的中间件误判。按"不大包
// 大揽"放弃绕法，接受 hono 的默认行为——但两条后果必须被钉死，否则只会在用户那里发现。
describe("the @Head limitation on hono", () => {
  test("a HEAD route without a GET sibling is unreachable", async () => {
    await withEngine(
      [route("HEAD", "/only-head", () => Promise.resolve(new Response(null)))],
      async (base) => {
        const response = await fetch(`${base}/only-head`, { method: "HEAD" });

        // 同一份代码在 web-node 下是 200，而编译器不要求 HEAD 路由有 GET 兄弟：编译期零诊断
        expect(response.status).toBe(404);
      },
    );
  });

  test("a HEAD route alongside a GET route runs the GET handler with the body dropped", async () => {
    await withEngine(
      [
        route("GET", "/both", () => Promise.resolve(new Response("from-get"))),
        route("HEAD", "/both", () =>
          Promise.resolve(new Response(null, { headers: { "x-head-handler": "ran" } })),
        ),
      ],
      async (base) => {
        const response = await fetch(`${base}/both`, { method: "HEAD" });

        expect(response.status).toBe(200);
        expect(await response.text()).toBe("");
        // @Head 写的那份 handler 不执行——HTTP 语义正确，但用户的代码被影子掉了
        expect(response.headers.get("x-head-handler")).toBeNull();
      },
    );
  });
});

describe("engine lifecycle", () => {
  test("starting a running engine is rejected", async () => {
    const engine = new WebEngine({ port: 0 }, [], []);
    const handle = await engine.start({ routes: [] });
    try {
      await expect(engine.start({ routes: [] })).rejects.toThrow("already running");
    } finally {
      await handle.close();
    }
  });

  test("onContextClose before any start is a no-op", async () => {
    const engine = new WebEngine({ port: 0 }, [], []);

    await engine.onContextClose();
    await engine.onContextClose();
  });
});
