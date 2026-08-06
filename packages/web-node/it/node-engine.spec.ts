import type { Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import type { PreparedRoute, WebApplication } from "@reforce/web/adapter";
import { describe, expect, test } from "vitest";
import { WebEngine, type WebNodeServeSettings } from "@/index";

// 真实 node:http 服务器上的引擎契约（#207，镜像 web-bun 时代的 Bun.serve 契约 #153）：
// 路由分发、参数路由、404/405、优雅关闭排空。路由的 handle 用最小闭包替身——引擎的职责
// 边界就是"把请求交给 handle"，作用域/洋葱链属于 @reforce/web 的测试面。

function application(routes: readonly PreparedRoute[]): WebApplication {
  return { routes };
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
    const socket = connect(port, "127.0.0.1", () => {
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

describe("WebEngine over a real node:http server", () => {
  test("a parameterized route receives the extracted path params", async () => {
    await withEngine(
      [
        {
          method: "GET",
          path: "/users/:id",
          handle: (_request, params) => Promise.resolve(Response.json({ id: params.id })),
        },
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
        { method: "GET", path: "/items", handle: () => Promise.resolve(new Response("get")) },
        { method: "POST", path: "/items", handle: () => Promise.resolve(new Response("post")) },
      ],
      async (base) => {
        expect(await (await fetch(`${base}/items`)).text()).toBe("get");
        expect(await (await fetch(`${base}/items`, { method: "POST" })).text()).toBe("post");
      },
    );
  });

  test("a request body streams through to the route handler", async () => {
    await withEngine(
      [
        {
          method: "POST",
          path: "/echo",
          handle: async (request) => new Response(await request.text()),
        },
      ],
      async (base) => {
        const response = await fetch(`${base}/echo`, { method: "POST", body: "payload" });

        expect(await response.text()).toBe("payload");
      },
    );
  });

  test("an unknown path yields 404", async () => {
    await withEngine(
      [{ method: "GET", path: "/items", handle: () => Promise.resolve(new Response("get")) }],
      async (base) => {
        const response = await fetch(`${base}/nope`);

        expect(response.status).toBe(404);
      },
    );
  });

  test("a method mismatch yields 405 with the Allow header", async () => {
    await withEngine(
      [
        { method: "GET", path: "/items/:id", handle: () => Promise.resolve(new Response("get")) },
        { method: "PUT", path: "/items/:id", handle: () => Promise.resolve(new Response("put")) },
      ],
      async (base) => {
        const response = await fetch(`${base}/items/9`, { method: "DELETE" });

        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("GET, PUT");
      },
    );
  });

  // 坏转义的用户可见后果（#211）：分派一旦抛异常，serve() 是被 `void` 调用的 async 函数，
  // 异常变成 unhandled rejection，响应永不写出，客户端只能挂到超时。超时断言就是那道护栏。
  test("a malformed percent-escape in the path yields 404 instead of hanging", async () => {
    await withEngine(
      [
        {
          method: "GET",
          path: "/users/:id",
          handle: (_request, params) => Promise.resolve(Response.json({ id: params.id })),
        },
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
      [{ method: "GET", path: "/users/:id", handle: () => Promise.resolve(new Response("get")) }],
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
    const engine = new WebEngine({ port: 0 });
    const handle = await engine.start(
      application([
        {
          method: "GET",
          path: "/slow",
          handle: async () => {
            await gate;
            return new Response("drained");
          },
        },
      ]),
    );
    const base = serverUrlOf(engine);

    const inflight = fetch(`${base}/slow`).then((response) => response.text());
    // 确保请求已到达 handler（node:http 接受连接是异步的）
    await new Promise((resolve) => setTimeout(resolve, 50));
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
      application([
        { method: "GET", path: "/items", handle: () => Promise.resolve(new Response("get")) },
      ]),
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
          {
            method: "GET",
            path: "/stream",
            handle: () =>
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
          },
          { method: "GET", path: "/items", handle: () => Promise.resolve(new Response("get")) },
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
        [{ method: "GET", path: "/items", handle: () => Promise.resolve(new Response("get")) }],
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
        [{ method: "GET", path: "/items", handle: () => Promise.resolve(new Response("get")) }],
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
        {
          method: "GET",
          path: "/evil.com/health",
          handle: (request) => {
            seen = new URL(request.url).host;
            return Promise.resolve(new Response("ok"));
          },
        },
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
      [{ method: "GET", path: "/items", handle: () => Promise.resolve(new Response("get")) }],
      async (base) => {
        const response = await fetch(`${base}//items`);

        expect(await response.text()).toBe("get");
      },
    );
  });
});
