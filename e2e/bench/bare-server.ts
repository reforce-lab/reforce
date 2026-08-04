// 天花板基线（#153 基准 ①）：与 fixture 应用同逻辑的手写 Bun.serve。路由分发同样交给
// Bun 原生 routes——两侧的差值因此只剩框架抽象（请求作用域 + 洋葱链 + schema 校验/decode +
// 特化序列化），不含路由查找差异。逻辑对齐 /health 与 /users/:id（数字校验、admission
// 头检查、bigint 往返、响应形状）。

const server = Bun.serve({
  port: 0,
  routes: {
    "/health": () => new Response("ok"),
    "/users/:id": {
      GET: (request) => {
        const { id } = request.params;
        if (!/^[0-9]+$/.test(id)) {
          return new Response(JSON.stringify({ error: "request validation failed" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (request.headers.get("x-user") === null) {
          return new Response(JSON.stringify({ error: "forbidden" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        }
        const value = BigInt(id);
        return new Response(JSON.stringify({ id: value.toString(), name: `user-${value}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
  fetch: () => new Response(null, { status: 404 }),
});

process.stderr.write(`[bare] listening on ${server.url.href}\n`);
