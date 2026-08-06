import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
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
});
