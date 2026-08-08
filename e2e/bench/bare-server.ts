// 天花板基线（#153 基准 ①，#207 迁移到 node:http）：与 fixture 应用同逻辑的手写服务器。
// 路由分发写成能匹配同一组路径的最小形式（两条硬编码分支 + 一个正则）。#211 之前它与
// @reforce/web-node 用的是同一套段匹配规则，两侧差值不含路由查找；现在 web-node 走
// find-my-way 的 radix 树，这里刻意不跟进——基线的定义就是"手写能做到的最快"，差值里因此
// 含一份路由查找差异（本例只有 2 条路由，radix 相对正则的优势体现不出来，这份差异很小）。
// 逻辑对齐 /health 与 /users/:id（数字校验、admission 头检查、bigint 往返、响应形状）。
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

// 端口由压测父进程先占后放再交下来（#371）：就绪判据从"日志里正则出监听地址"换成"这个端口
// 能连上"，被测进程的输出因此可以整个丢掉，请求日志的落盘成本不再被算进框架税。
server.listen(Number(process.env.BARE_SERVER_PORT ?? 0), "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The bare baseline must listen on a TCP address.");
  }
  process.stderr.write(`[bare] listening on http://127.0.0.1:${address.port}/\n`);
});
