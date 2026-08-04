import { describe, expect, test } from "bun:test";
import type { PreparedRoute, WebApplication } from "@reforce/web/adapter";
import { WebEngine } from "@/index";

// 真实 Bun.serve 上的引擎契约（#153）：原生 routes 分发、参数路由、404/405 冷路径、
// 优雅关闭排空。路由的 handle 在这里用最小闭包替身——引擎的职责边界就是"把请求交给
// handle"，作用域/洋葱链属于 @reforce/web 的测试面。

function application(routes: readonly PreparedRoute[]): WebApplication {
  return { routes };
}

async function withEngine(
  routes: readonly PreparedRoute[],
  run: (base: string, engine: WebEngine) => Promise<void>,
): Promise<void> {
  const engine = new WebEngine({ port: 0 });
  const handle = engine.start(application(routes));
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
  const server = Reflect.get(engine, "server") as { url: URL };
  return server.url.href.replace(/\/$/, "");
}

describe("WebEngine over a real Bun.serve", () => {
  test("a parameterized route receives the native path params", async () => {
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

  test("an unknown path yields the 404 cold path", async () => {
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

  test("close drains the in-flight request before resolving", async () => {
    let released: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const engine = new WebEngine({ port: 0 });
    const handle = engine.start(
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
    // 确保请求已到达 handler（Bun.serve 接受连接是异步的）
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

  test("starting a running engine is rejected", async () => {
    const engine = new WebEngine({ port: 0 });
    const handle = engine.start(application([]));
    try {
      expect(() => engine.start(application([]))).toThrow("already running");
    } finally {
      await handle.close();
    }
  });

  test("onContextClose after handle.close is an idempotent no-op", async () => {
    const engine = new WebEngine({ port: 0 });
    const handle = engine.start(application([]));

    await handle.close();
    await engine.onContextClose();
    await engine.onContextClose();
  });
});
