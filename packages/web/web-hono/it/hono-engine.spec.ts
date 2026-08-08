import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { absorbResponse, defineRouteMarker, type RouteOutcome } from "@reforce/web-core";
import type { PreparedRoute, WebApplication } from "@reforce/web-core/adapter";
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
// 引擎无关的契约行为由 @reforce/web-core/conformance 覆盖（见 it/conformance.spec.ts），这里不重复。

const RateLimit = defineRouteMarker<{ readonly max: number }>("rateLimit");

// 用例的 handler 写成返回标准 Response 是有意的——它们扮演的正是用户 handler 走逃生口那条路。
// 真实管道里那个 Response 会被序列化层吸收成内部货币（#340），所以这里也吸收一次，否则测的
// 就不是引擎真正会收到的东西。
function route(
  method: PreparedRoute["method"],
  path: string,
  handle: (
    request: Request,
    params: Readonly<Record<string, string>>,
  ) => RouteOutcome | Promise<RouteOutcome>,
  meta: Readonly<Record<string, unknown>> = {},
): PreparedRoute {
  return {
    method,
    path,
    handle: async (request, params) => {
      const outcome = await handle(request, params);
      return outcome instanceof Response ? absorbResponse(outcome, new Headers()) : outcome;
    },
    meta: (marker) => Reflect.get(meta, marker.key) as never,
  };
}

async function withEngine(
  routes: readonly PreparedRoute[],
  run: (base: string) => Promise<void>,
  bridges: {
    readonly configurers?: readonly HonoConfigurer[];
    readonly customizers?: readonly HonoRouteCustomizer[];
    readonly logNotFound?: WebApplication["logNotFound"];
  } = {},
): Promise<void> {
  const engine = new WebEngine({ port: 0 }, bridges.configurers ?? [], bridges.customizers ?? []);
  const application: WebApplication = {
    routes,
    ...(bridges.logNotFound === undefined ? {} : { logNotFound: bridges.logNotFound }),
  };
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

// 真未命中语义（RFC 0011 C7 打磨，#242）：与 fastify 的 setNotFoundHandler 对齐——只有
// 路由器一无所中才是未命中；任何路由（reforce 的或 configurer 的）自己答的 404 已由请求
// 日志记账，观察者再记一条就是重复且失真。
describe("the not-found observer", () => {
  test("reports a request no route matched", async () => {
    const misses: { readonly method: string; readonly path: string }[] = [];
    await withEngine(
      [ping],
      async (base) => {
        await fetch(`${base}/nowhere`);
      },
      { logNotFound: (miss) => void misses.push(miss) },
    );

    expect(misses).toEqual([{ method: "GET", path: "/nowhere" }]);
  });

  test("stays quiet when a reforce handler answers 404 itself", async () => {
    const misses: unknown[] = [];
    await withEngine(
      [route("GET", "/orders/:id", () => Promise.resolve(new Response(null, { status: 404 })))],
      async (base) => {
        await fetch(`${base}/orders/42`);
      },
      { logNotFound: (miss) => void misses.push(miss) },
    );

    expect(misses).toEqual([]);
  });

  test("stays quiet when a configurer's own route answers 404", async () => {
    const misses: unknown[] = [];
    await withEngine(
      [ping],
      async (base) => {
        await fetch(`${base}/static/missing.png`);
      },
      {
        configurers: [
          {
            configure: (app) => {
              app.get("/static/:file", (context) => context.body(null, 404));
            },
          },
        ],
        logNotFound: (miss) => void misses.push(miss),
      },
    );

    expect(misses).toEqual([]);
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

// 缺省监听面（#323）：不配 hostname 时只绑本机回环。此前 @hono/node-server 拿不到 hostname
// 就走 node 的缺省，绑的是全接口——同网段任何人访问一条出错路由就能看到 dev 错误页里的堆栈
// 与源码，而同一份配置换到 fastify 上又只绑 localhost。断言看的是 server.address()，即内核
// 实际绑上的地址。
describe("the listen hostname", () => {
  const loopback = new Set(["127.0.0.1", "::1"]);

  async function boundAddress(hostname?: string): Promise<AddressInfo> {
    const engine = new WebEngine(
      { port: 0, ...(hostname === undefined ? {} : { hostname }) },
      [],
      [],
    );
    const handle = await engine.start({ routes: [ping] });
    try {
      return (Reflect.get(engine, "server") as Server).address() as AddressInfo;
    } finally {
      await handle.close();
    }
  }

  test("binds a loopback address when the application configured none", async () => {
    const address = await boundAddress();

    expect(loopback.has(address.address)).toBe(true);
  });

  // 反向用例，同时钉住上一条不是空转：显式配置一律照办，收紧的是缺省而不是用户的决定权。
  test("binds the wildcard address the application configured", async () => {
    const address = await boundAddress("0.0.0.0");

    expect(address.address).toBe("0.0.0.0");
  });
});
