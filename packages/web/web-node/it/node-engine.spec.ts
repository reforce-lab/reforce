import type { Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { absorbResponse, type RouteOutcome } from "@reforce/web-core";
import type { PreparedRoute, WebApplication } from "@reforce/web-core/adapter";
import { describe, expect, test } from "vitest";
import { WebEngine, type WebNodeServeSettings } from "@/index";

// 真实 node:http 服务器上的引擎契约（#207，镜像 web-bun 时代的 Bun.serve 契约 #153）：
// 路由分发、参数路由、404（未命中与方法不符同待遇）、优雅关闭排空。handle 用最小闭包替身——引擎的职责
// 边界就是"把请求交给 handle"，作用域/洋葱链属于 @reforce/web-core 的测试面。

function application(routes: readonly PreparedRoute[]): WebApplication {
  return { routes };
}

// 引擎的职责边界是"把请求交给 handle"，PreparedRoute 的其余字段在这一层没有被测语义，
// 集中给缺省值，避免每条用例重复写。
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
    meta: () => undefined,
  };
}

async function withEngine(
  routes: readonly PreparedRoute[],
  run: (base: string, engine: WebEngine) => Promise<void>,
  settings: Omit<WebNodeServeSettings, "port"> = {},
): Promise<void> {
  const engine = new WebEngine({ port: 0, ...settings });
  const handle = await engine.start(application(routes));
  const url = serverUrlOf(engine);
  try {
    await run(url, engine);
  } finally {
    await handle.close();
  }
}

// 引擎不公开 server 句柄（契约面只有 close），测试从监听日志外读端口会引入脆弱的
// stdout 解析；这里对私有字段的反射读取只服务测试定位端口。
function serverUrlOf(engine: WebEngine): string {
  const server = Reflect.get(engine, "server") as Server;
  const address = server.address() as AddressInfo;
  return `http://localhost:${address.port}`;
}

// fetch/undici 会自己生成合法 Host 头，畸形 Host 只能从裸 socket 发。返回状态行。
function rawRequest(
  base: string,
  requestLine: string,
  headers: readonly string[],
): Promise<string> {
  const port = Number(new URL(base).port);
  return new Promise((resolve, reject) => {
    // 走 base 里的主机名而不是写死 127.0.0.1：服务缺省绑 localhost（#323），而 localhost 解析
    // 成 IPv4 还是 IPv6 回环由各平台的 hosts/解析器决定，写死一边会在另一边被拒。
    const socket = connect(port, new URL(base).hostname, () => {
      socket.write(`${requestLine}\r\n${headers.join("\r\n")}\r\nConnection: close\r\n\r\n`);
    });
    let received = "";
    socket.setTimeout(5_000, () => socket.destroy(new Error("raw request timed out")));
    socket.on("data", (chunk) => {
      received += chunk.toString();
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(received.split("\r\n")[0] ?? ""));
  });
}

// 断言"没有 unhandled rejection"必须自己挂监听：vitest 也挂了一个，但它把故障算在整个文件
// 上，看不出是哪条用例、也无法在用例内断言。
async function withoutUnhandledRejections(run: () => Promise<void>): Promise<void> {
  const escaped: unknown[] = [];
  const capture = (reason: unknown): void => {
    escaped.push(reason);
  };
  process.on("unhandledRejection", capture);
  try {
    await run();
    // rejection 的上报排在微任务之后，给它一个宏任务的窗口再断言
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(escaped).toEqual([]);
  } finally {
    process.off("unhandledRejection", capture);
  }
}

// 缺省监听面（#323）：不配 hostname 时只绑本机回环。此前 node 省略 host 参数吃 node 的缺省，
// 绑的是全接口——同网段任何人访问一条出错路由就能看到 dev 错误页里的堆栈与源码，而同一份
// 配置换到 fastify 上又只绑 localhost。断言看的是 server.address()，即内核实际绑上的地址。
describe("the listen hostname", () => {
  const loopback = new Set(["127.0.0.1", "::1"]);
  const ping = route("GET", "/ping", () => Promise.resolve(new Response("pong")));

  function boundAddress(engine: WebEngine): AddressInfo {
    return (Reflect.get(engine, "server") as Server).address() as AddressInfo;
  }

  test("binds a loopback address when the application configured none", async () => {
    await withEngine([ping], async (_base, engine) => {
      expect(loopback.has(boundAddress(engine).address)).toBe(true);
    });
  });

  // 反向用例，同时钉住上一条不是空转：显式配置一律照办，收紧的是缺省而不是用户的决定权。
  test("binds the wildcard address the application configured", async () => {
    await withEngine(
      [ping],
      async (_base, engine) => {
        expect(boundAddress(engine).address).toBe("0.0.0.0");
      },
      { hostname: "0.0.0.0" },
    );
  });
});

describe("WebEngine over a real node:http server", () => {
  test("a parameterized route receives the extracted path params", async () => {
    await withEngine(
      [
        route("GET", "/users/:id", (_request, params) =>
          Promise.resolve(Response.json({ id: params.id })),
        ),
      ],
      async (base) => {
        const response = await fetch(`${base}/users/42`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: "42" });
      },
    );
  });

  test("two methods on one path dispatch to their own handlers", async () => {
    await withEngine(
      [
        route("GET", "/items", () => Promise.resolve(new Response("get"))),
        route("POST", "/items", () => Promise.resolve(new Response("post"))),
      ],
      async (base) => {
        expect(await (await fetch(`${base}/items`)).text()).toBe("get");
        expect(await (await fetch(`${base}/items`, { method: "POST" })).text()).toBe("post");
      },
    );
  });

  test("a request body streams through to the route handler", async () => {
    await withEngine(
      [route("POST", "/echo", async (request) => new Response(await request.text()))],
      async (base) => {
        const response = await fetch(`${base}/echo`, { method: "POST", body: "payload" });

        expect(await response.text()).toBe("payload");
      },
    );
  });

  test("an unknown path yields 404", async () => {
    await withEngine(
      [route("GET", "/items", () => Promise.resolve(new Response("get")))],
      async (base) => {
        const response = await fetch(`${base}/nope`);

        expect(response.status).toBe(404);
      },
    );
  });

  // 方法不符返回裸 404 且不带 Allow（WebEngineAdapter 契约）。代价是 OPTIONS /health 也是
  // 404，预检交给引擎生态的 cors 中间件——它跑在路由匹配之前。
  test("a method mismatch yields 404 without an Allow header", async () => {
    await withEngine(
      [
        route("GET", "/items/:id", () => Promise.resolve(new Response("get"))),
        route("PUT", "/items/:id", () => Promise.resolve(new Response("put"))),
      ],
      async (base) => {
        const response = await fetch(`${base}/items/9`, { method: "DELETE" });

        expect(response.status).toBe(404);
        expect(response.headers.get("allow")).toBeNull();
      },
    );
  });

  // 坏转义的用户可见后果（#211）：分派一旦抛异常，serve() 是被 `void` 调用的 async 函数，
  // 异常变成 unhandled rejection，响应永不写出，客户端只能挂到超时。超时断言就是那道护栏。
  test("a malformed percent-escape in the path yields 404 instead of hanging", async () => {
    await withEngine(
      [
        route("GET", "/users/:id", (_request, params) =>
          Promise.resolve(Response.json({ id: params.id })),
        ),
      ],
      async (base) => {
        const response = await fetch(`${base}/users/%ZZ`, { signal: AbortSignal.timeout(1_000) });

        expect(response.status).toBe(404);
      },
    );
  });

  // 唯一覆盖 settings → createRouter 这段接线的用例（#211）
  test("a configured maxParamLength turns an over-length param into 404", async () => {
    await withEngine(
      [route("GET", "/users/:id", () => Promise.resolve(new Response("get")))],
      async (base) => {
        const response = await fetch(`${base}/users/123456789`);

        expect(response.status).toBe(404);
      },
      { maxParamLength: 8 },
    );
  });

  test("close drains the in-flight request before resolving", async () => {
    let released: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    // "handler 已进入"的确定性屏障：close 必须在请求真的到达 handler 之后才调，否则它会
    // 因为还没有在途请求而立刻 resolve。用 sleep 猜这个时刻在并发跑测试文件时会翻车
    // （同 #177 / #225 的处理方式：把竞态移出测试路径，不要靠等）。
    let reached: (() => void) | undefined;
    const handlerReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const engine = new WebEngine({ port: 0 });
    const handle = await engine.start(
      application([
        route("GET", "/slow", async () => {
          reached?.();
          await gate;
          return new Response("drained");
        }),
      ]),
    );
    const base = serverUrlOf(engine);

    const inflight = fetch(`${base}/slow`).then((response) => response.text());
    await handlerReached;
    let closed = false;
    const closing = handle.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);

    released?.();
    await closing;
    expect(await inflight).toBe("drained");
  });

  test("close resolves promptly with only idle keep-alive connections", async () => {
    const engine = new WebEngine({ port: 0 });
    const handle = await engine.start(
      application([route("GET", "/items", () => Promise.resolve(new Response("get")))]),
    );
    const base = serverUrlOf(engine);
    // undici 默认 keep-alive：请求结束后连接空闲驻留，close 不得被它拖住
    await fetch(`${base}/items`);

    const deadline = Date.now() + 5_000;
    await handle.close();

    expect(Date.now()).toBeLessThan(deadline);
  });

  test("starting a running engine is rejected", async () => {
    const engine = new WebEngine({ port: 0 });
    const handle = await engine.start(application([]));
    try {
      await expect(engine.start(application([]))).rejects.toThrow("already running");
    } finally {
      await handle.close();
    }
  });

  test("onContextClose after handle.close is an idempotent no-op", async () => {
    const engine = new WebEngine({ port: 0 });
    const handle = await engine.start(application([]));

    await handle.close();
    await engine.onContextClose();
    await engine.onContextClose();
  });

  // 写出期故障不在 PreparedRoute.handle 的"永不 reject"契约内（#226）：客户端读到一半断开，
  // pipeline 抛 ERR_STREAM_PREMATURE_CLOSE，而 serve() 是被 void 调用的 async 函数，
  // 异常无处可去 → unhandled rejection → 默认 Node 行为是进程退出。任何客户端都能远程触发。
  test("a client that disconnects mid-response leaves the server alive and serving", async () => {
    await withoutUnhandledRejections(async () => {
      await withEngine(
        [
          route("GET", "/stream", () =>
            Promise.resolve(
              new Response(
                new ReadableStream({
                  async pull(controller) {
                    controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
                    await new Promise((resolve) => setTimeout(resolve, 20));
                  },
                }),
              ),
            ),
          ),
          route("GET", "/items", () => Promise.resolve(new Response("get"))),
        ],
        async (base) => {
          const controller = new AbortController();
          const response = await fetch(`${base}/stream`, { signal: controller.signal });
          await response.body?.getReader().read();
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 100));

          expect(await (await fetch(`${base}/items`)).text()).toBe("get");
        },
      );
    });
  });

  test("a malformed Host header yields 400 instead of crashing the process", async () => {
    await withoutUnhandledRejections(async () => {
      await withEngine(
        [route("GET", "/items", () => Promise.resolve(new Response("get")))],
        async (base) => {
          const status = await rawRequest(base, "GET /items HTTP/1.1", ["Host: a b"]);

          expect(status).toContain("400");
        },
      );
    });
  });

  // Host 里的 userinfo 是同一类缺陷的第二个入口（#226）：new URL("http://user@evil.com") 成功，
  // 但 Fetch 规范要求带凭据的 URL 让 new Request 抛 TypeError——崩点从分派挪到了 toRequest。
  test("a Host header carrying userinfo yields 400 instead of crashing the process", async () => {
    await withoutUnhandledRejections(async () => {
      await withEngine(
        [route("GET", "/items", () => Promise.resolve(new Response("get")))],
        async (base) => {
          const status = await rawRequest(base, "GET /items HTTP/1.1", ["Host: user@evil.com"]);

          expect(status).toContain("400");
        },
      );
    });
  });

  // 请求目标由请求方完全控制（#226），`//evil.com/x` 在 WHATWG URL 解析下是 protocol-relative
  // 引用：new URL(target, base) 会把 host 换成 evil.com，handler 拿 url.origin 拼跳转即
  // 开放重定向。authority 只能来自 Host 头。
  test("a protocol-relative request target does not move the request URL host", async () => {
    let seen: string | undefined;
    await withEngine(
      [
        route("GET", "/evil.com/health", (request) => {
          seen = new URL(request.url).host;
          return Promise.resolve(new Response("ok"));
        }),
      ],
      async (base) => {
        await fetch(`${base}//evil.com/health`);

        expect(seen).toBe(new URL(base).host);
      },
    );
  });

  // 上一条改的是 URL 构造方式，这条钉住它没有顺手破坏 `//p` ≡ `/p` 的路径归一
  test("a duplicated leading slash still matches the registered route", async () => {
    await withEngine(
      [route("GET", "/items", () => Promise.resolve(new Response("get")))],
      async (base) => {
        const response = await fetch(`${base}//items`);

        expect(await response.text()).toBe("get");
      },
    );
  });
});
