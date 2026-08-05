// 天花板基线（#153 基准 ①，#207 迁移到 node:http）：与 fixture 应用同逻辑的手写服务器。
// 路由分发用与 @reforce/web-node 相同的段匹配规则——两侧的差值因此只剩框架抽象（请求
// 作用域 + 洋葱链 + schema 校验/decode + 特化序列化），不含路由查找差异。逻辑对齐
// /health 与 /users/:id（数字校验、admission 头检查、bigint 往返、响应形状）。
import { createServer } from "node:http";

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "text/plain;charset=utf-8" });
    response.end("ok");
    return;
  }
  const userMatch = /^\/users\/([^/]+)$/.exec(url.pathname);
  const id = userMatch?.[1];
  if (id !== undefined && request.method === "GET") {
    const respond = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const decoded = decodeURIComponent(id);
    if (!/^[0-9]+$/.test(decoded)) {
      respond(400, { error: "request validation failed" });
      return;
    }
    if (request.headers["x-user"] === undefined) {
      respond(403, { error: "forbidden" });
      return;
    }
    const value = BigInt(decoded);
    respond(200, { id: value.toString(), name: `user-${value}` });
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(0, () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The bare baseline must listen on a TCP address.");
  }
  process.stderr.write(`[bare] listening on http://localhost:${address.port}/\n`);
});
