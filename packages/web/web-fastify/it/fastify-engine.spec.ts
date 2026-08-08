import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { absorbResponse, defineRouteMarker, type RouteOutcome } from "@reforce/web-core";
import type { PreparedRoute, WebApplication } from "@reforce/web-core/adapter";
import type { FastifyInstance } from "fastify";
import { describe, expect, test } from "vitest";
import {
  type FastifyConfigure,
  type FastifyConfigurer,
  type FastifyRouteCustomize,
  type FastifyRouteCustomizer,
  WebEngine,
} from "@/index";
import type { WebFastifyServeSettings } from "@/settings";

// fastify 引擎的自有面：两座桥、自装的 buffer parser、fastify 特有的取舍。
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
      // 测试桩把内部货币的入口对象物化回标准 Request——用例写的是 handler 视角的断言，
      // 引擎侧的惰性由 it/lazy-request.spec.ts 单独盯。
      const outcome = await handle(request.standard(), params);
      return outcome instanceof Response ? absorbResponse(outcome, new Headers()) : outcome;
    },
    meta: (marker) => Reflect.get(meta, marker.key) as never,
  };
}

async function withEngine(
  routes: readonly PreparedRoute[],
  run: (base: string) => Promise<void>,
  bridges: {
    readonly configurers?: readonly FastifyConfigurer[];
    readonly customizers?: readonly FastifyRouteCustomizer[];
    readonly settings?: Omit<WebFastifyServeSettings, "port">;
  } = {},
): Promise<void> {
  const engine = new WebEngine(
    { port: 0, ...bridges.settings },
    bridges.configurers ?? [],
    bridges.customizers ?? [],
  );
  const application: WebApplication = { routes };
  const handle = await engine.start(application);
  const app = Reflect.get(engine, "app") as FastifyInstance;
  const address = (app.server as Server).address() as AddressInfo;
  try {
    await run(`http://localhost:${address.port}`);
  } finally {
    await handle.close();
  }
}

const ping = route("GET", "/ping", () => Promise.resolve(new Response("pong")));

// body 原样回显：用来观察引擎到底把什么字节交给了 reforce
const echo = route("POST", "/echo", async (request) =>
  Response.json({
    contentType: request.headers.get("content-type"),
    text: await request.text(),
  }),
);

describe("the application-level configurer bridge", () => {
  test("a configurer installs a global fastify hook around every route", async () => {
    class Stamp implements FastifyConfigurer {
      // 字段形态：app 自动带类型，用户不必标注
      configure: FastifyConfigure = (app) => {
        app.addHook("onSend", async (_request, reply) => {
          reply.header("x-stamped", "yes");
        });
      };
    }

    await withEngine(
      [ping],
      async (base) => {
        expect((await fetch(`${base}/ping`)).headers.get("x-stamped")).toBe("yes");
      },
      { configurers: [new Stamp()] },
    );
  });

  test("an async configurer is awaited before any route is registered", async () => {
    class Slow implements FastifyConfigurer {
      configure: FastifyConfigure = async (app) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        app.addHook("onSend", async (_request, reply) => {
          reply.header("x-late", "installed");
        });
      };
    }

    await withEngine(
      [ping],
      async (base) => {
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
  test("a customizer reaches a route's native fastify config by marker", async () => {
    const limited = route("GET", "/limited", () => Promise.resolve(new Response("limited")), {
      rateLimit: { max: 5 },
    });
    class RouteLimits implements FastifyRouteCustomizer {
      // 字段形态：route 参数自动带类型
      customize: FastifyRouteCustomize = (item) => {
        const limit = item.meta(RateLimit);
        return limit === undefined ? undefined : { config: { rateLimit: { max: limit.max } } };
      };
    }
    // config 是 fastify 原生的 per-route 槽位，从钩子里按原生方式读回
    class ReportConfig implements FastifyConfigurer {
      configure: FastifyConfigure = (app) => {
        app.addHook("onSend", async (request, reply) => {
          const config = Reflect.get(Object(request.routeOptions.config), "rateLimit");
          reply.header("x-rate-limit", String(Reflect.get(Object(config), "max")));
        });
      };
    }

    await withEngine(
      [ping, limited],
      async (base) => {
        expect((await fetch(`${base}/limited`)).headers.get("x-rate-limit")).toBe("5");
        expect((await fetch(`${base}/ping`)).headers.get("x-rate-limit")).toBe("undefined");
      },
      { configurers: [new ReportConfig()], customizers: [new RouteLimits()] },
    );
  });

  test("a customizer preHandler can short-circuit before the reforce handler", async () => {
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
          {
            customize: () => ({
              preHandler: async (_request, reply) => {
                await reply.code(403).send("denied");
              },
            }),
          },
        ],
      },
    );
  });

  // 合并规则是硬错而不是静默丢弃：静默丢弃会让用户以为定制生效了
  for (const key of ["method", "url", "handler"] as const) {
    test(`a customizer overriding ${key} fails the start`, async () => {
      const engine = new WebEngine(
        { port: 0 },
        [],
        [{ customize: () => ({ [key]: "hijacked" }) as never }],
      );

      await expect(engine.start({ routes: [ping] })).rejects.toThrow(`may not override "${key}"`);
    });
  }

  // fast-json-stringify 会插进序列化路径，与 @reforce/web-core 的 schema 白名单投影双重裁剪，
  // 结果不可预测——所以这条也硬拒（决定 9）。
  test("a customizer setting schema.response fails the start", async () => {
    const engine = new WebEngine(
      { port: 0 },
      [],
      [{ customize: () => ({ schema: { response: { 200: { type: "object" } } } }) }],
    );

    await expect(engine.start({ routes: [ping] })).rejects.toThrow("schema.response");
  });

  test("a customizer may still set other schema slots", async () => {
    await withEngine(
      [ping],
      async (base) => {
        expect(await (await fetch(`${base}/ping`)).text()).toBe("pong");
      },
      { customizers: [{ customize: () => ({ schema: { querystring: { type: "object" } } }) }] },
    );
  });
});

// 自装 buffer parser 的意义：放任 fastify 默认解析会把一整类 4xx 挪出 reforce 洋葱——
// 畸形 JSON → FST_ERR_CTP_INVALID_JSON_BODY、空 body → FST_ERR_CTP_EMPTY_JSON_BODY、
// 未知 content-type → 415，三者都不经 observability 中间件、不经 reforce 的错误处理器。
describe("the buffer content-type parser", () => {
  test("a malformed JSON body reaches the reforce handler instead of a fastify 400", async () => {
    await withEngine([echo], async (base) => {
      const response = await fetch(`${base}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ text: "{not-json" });
    });
  });

  test("an unknown content type reaches the reforce handler instead of a fastify 415", async () => {
    await withEngine([echo], async (base) => {
      const response = await fetch(`${base}/echo`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: "raw-bytes",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ text: "raw-bytes" });
    });
  });

  test("an empty body reaches the reforce handler instead of a fastify 400", async () => {
    await withEngine([echo], async (base) => {
      const response = await fetch(`${base}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ text: "" });
    });
  });

  // 重建标准 Request 时 body 传的是 Buffer（BufferSource）：undici 对它既不推导也不覆写
  // content-type，原始头因此原样存活——multipart 的 boundary 保得住，formData() 才解得开。
  test("a multipart boundary survives the rebuild into a standard Request", async () => {
    await withEngine([echo], async (base) => {
      const form = new FormData();
      form.append("name", "amy");

      const response = await fetch(`${base}/echo`, { method: "POST", body: form });
      const seen = (await response.json()) as { contentType: string; text: string };

      expect(seen.contentType).toContain("multipart/form-data; boundary=");
      expect(seen.text).toContain('name="name"');
    });
  });

  test("bodyLimit still applies and yields 413", async () => {
    await withEngine(
      [echo],
      async (base) => {
        const response = await fetch(`${base}/echo`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "x".repeat(200),
        });

        expect(response.status).toBe(413);
      },
      { settings: { bodyLimit: 64 } },
    );
  });
});

describe("fastify-specific routing settings", () => {
  // fastify 默认 maxParamLength 是 100、web-node 默认不限制。不显式对齐的话，同一份应用
  // 换到 fastify 上会把长参数请求静默变成 404。
  test("a long path param is not silently a 404 by default", async () => {
    await withEngine(
      [route("GET", "/users/:id", (_request, params) => Promise.resolve(new Response(params.id)))],
      async (base) => {
        const long = "9".repeat(300);

        expect(await (await fetch(`${base}/users/${long}`)).text()).toBe(long);
      },
    );
  });

  // 已知的引擎间差异，不在 WebEngineAdapter 契约里、也不进一致性套件：同一个超长参数请求
  // web-node 回 404，fastify 回 414 URI Too Long。两边都是"请求被拒"，414 反而是更贴切的
  // 状态码，而这个设置本身是 opt-in 的，不值得为了对齐去拦截改写。写进 README。
  test("a configured maxParamLength rejects an over-length param with 414", async () => {
    await withEngine(
      [route("GET", "/users/:id", () => Promise.resolve(new Response("get")))],
      async (base) => {
        expect((await fetch(`${base}/users/123456789`)).status).toBe(414);
      },
      { settings: { maxParamLength: 8 } },
    );
  });

  // onBadUrl 是 raw 通道，且只对已注册过路由的方法触发；没有 POST 路由时同样的坏转义走的是
  // notFoundHandler。两条路径都必须是 404。
  test("a malformed escape is 404 on both the onBadUrl and the not-found path", async () => {
    await withEngine(
      [route("GET", "/users/:id", () => Promise.resolve(new Response("get")))],
      async (base) => {
        expect((await fetch(`${base}/users/%ZZ`)).status).toBe(404);
        expect((await fetch(`${base}/users/%ZZ`, { method: "POST" })).status).toBe(404);
      },
    );
  });
});

// exposeHeadRoutes 关掉了，两个理由都要钉住：与 web-node 语义一致，且 @Get + @Head 同路径
// 不会在启动期撞 FST_ERR_DUPLICATED_ROUTE。
describe("HEAD routing matches web-node", () => {
  test("an explicit HEAD route alongside a GET route on the same path starts and works", async () => {
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
        // hono 上这条相反：@Head 的 handler 被 GET 影子掉（见 web-hono 的已知约束）
        expect(response.headers.get("x-head-handler")).toBe("ran");
      },
    );
  });

  test("HEAD on a GET-only path is a 404, same as web-node", async () => {
    await withEngine(
      [route("GET", "/only-get", () => Promise.resolve(new Response("g")))],
      async (base) => {
        expect((await fetch(`${base}/only-get`, { method: "HEAD" })).status).toBe(404);
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

  // fastify 实例单次可用：close 之后再 listen 抛 FST_ERR_REOPENED_CLOSE_SERVER。实例必须在
  // start 里造而不是构造函数里，否则 HMR 的第二轮就炸。
  test("the same engine instance can start again after close", async () => {
    const engine = new WebEngine({ port: 0 }, [], []);
    for (let round = 0; round < 3; round += 1) {
      const handle = await engine.start({ routes: [ping] });
      const app = Reflect.get(engine, "app") as FastifyInstance;
      const address = (app.server as Server).address() as AddressInfo;

      expect(await (await fetch(`http://localhost:${address.port}/ping`)).text()).toBe("pong");

      await handle.close();
    }
  });
});

// L8（RFC 0011，#242）：我们不把 reforce 的 Logger 交给 Fastify——为迁就单个引擎给门面加
// child，方向是反的。但 L8 的立论前提是「开不开是用户的事」，而 fastify 的 logger 是构造期
// 选项、configurer 改不了，不从 settings 递出去用户就**没有任何办法**打开它。
describe("fastify's own logging stays the user's decision", () => {
  function capturing(): { readonly stream: Writable; readonly messages: () => readonly string[] } {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    return {
      stream,
      messages: () =>
        lines
          .join("")
          .split("\n")
          .flatMap((line) => {
            try {
              return [String(JSON.parse(line).msg)];
            } catch {
              return [];
            }
          }),
    };
  }

  // 缺省一个字都不该出：常被担心的「用户要维护两套日志配置」不成立，正是因为这一套默认
  // 是关的。断言写 stdout 而不是读 app.log 的内部字段——用户看到的就是流上的字节。
  test("writes nothing of its own by default", async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await withEngine([ping], async (base) => {
        expect(await (await fetch(`${base}/ping`)).text()).toBe("pong");
      });
    } finally {
      process.stdout.write = original;
    }

    expect(written).toEqual([]);
  });

  test("the settings hand fastify's native logger option straight through", async () => {
    const captured = capturing();

    await withEngine(
      [ping],
      async (base) => {
        expect((await fetch(`${base}/ping`)).status).toBe(200);
      },
      { settings: { logger: { level: "info", stream: captured.stream } } },
    );

    // fastify 原生那两条，逐字是它自己的文案——我们不翻译，所以断言的也是它的原话。
    expect(captured.messages()).toEqual(
      expect.arrayContaining(["incoming request", "request completed"]),
    );
  });

  test("disableRequestLogging drops the per-request pair and keeps the rest", async () => {
    const captured = capturing();

    await withEngine(
      [ping],
      async (base) => {
        expect((await fetch(`${base}/ping`)).status).toBe(200);
      },
      {
        settings: {
          logger: { level: "info", stream: captured.stream },
          disableRequestLogging: true,
        },
      },
    );

    expect(captured.messages()).not.toContain("incoming request");
    // logger 本身仍然是开的：关掉的只是每请求那两条，不是整套输出。
    expect(captured.messages()).toEqual(
      expect.arrayContaining([expect.stringContaining("Server")]),
    );
  });
});

// 缺省监听面（#323）：不配 hostname 时只绑本机回环。fastify 自己的缺省本来就是 localhost，
// 这两条用例钉的是"缺省从此由 @reforce/web-core 一处决定"——host 现在总是显式传进 listen，别人
// 把缺省改了也不会顺着漂过来；同一份配置在 node/hono 上的行为与这里一致。
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
      const app = Reflect.get(engine, "app") as FastifyInstance;
      return (app.server as Server).address() as AddressInfo;
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
