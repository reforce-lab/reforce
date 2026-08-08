import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Injectable, type OnContextClose } from "@reforce/core";
import type { WebApplication, WebApplicationHandle, WebEngineAdapter } from "@reforce/web/adapter";
import { webEngineAddress, webEngineHostname } from "@reforce/web/adapter";
import { createRouter } from "@/router";
import type { WebNodeServeSettings } from "@/settings";

// Node 引擎适配器（ADR 0006 W1/W2，#207）：node:http 没有原生 routes 表，分发由 @/router
// 承担；热路径上框架的活只剩每请求调用 route.handle（作用域开启→播种→洋葱链→兜底都在其
// 内部）。IncomingMessage ↔ Request、Response ↔ ServerResponse 的桥接是本文件唯一的底层
// 细节区，serve/writeResponse 之外都只说适配器契约的话。

function toHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  // headersDistinct 保留同名多值（set-cookie 等），req.headers 会把它们并成逗号串
  for (const [name, values] of Object.entries(request.headersDistinct)) {
    for (const value of values ?? []) {
      headers.append(name, value);
    }
  }
  return headers;
}

function toRequest(request: IncomingMessage, method: string, url: URL): Request {
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: toHeaders(request),
  };
  if (method !== "GET" && method !== "HEAD") {
    // undici 要求带流的 body 声明 duplex；GET/HEAD 依 Fetch 规范不得携带 body
    init.body = Readable.toWeb(request) as ReadableStream;
    init.duplex = "half";
  }
  return new Request(url, init);
}

// 请求 URL 的 authority 只能来自 Host 头（#226），路径与查询按"路径"赋值而不是按"URL 引用"解析：
// 请求目标是请求方完全控制的字符串，`new URL("//evil.com/health", base)` 会走 WHATWG 的
// protocol-relative 分支把 host 换成 evil.com，handler 拿 context.url.origin 拼跳转就此成为
// 开放重定向；顺带还让 `//p` 解析成路径 `/`，路由的 ignoreDuplicateSlashes 根本没机会归一。
// pathname 的 setter 不重新解析 authority，`//p` 保持为路径，归一仍归 @/router。
//
// 返回 undefined = Host 头畸形，调用方出 400。两种畸形都能被任意客户端远程触发，且都在
// 被 void 调用的 serve() 里抛出 → unhandled rejection → Node 默认行为是进程退出：
//   `Host: a b`            → new URL 抛 TypeError
//   `Host: user@evil.com`  → new URL 通过，但 Fetch 规范要求带凭据的 URL 让 new Request 抛
function requestUrl(request: IncomingMessage): URL | undefined {
  let url: URL;
  try {
    url = new URL(`http://${request.headers.host ?? "localhost"}`);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "") {
    return undefined;
  }
  const target = request.url ?? "/";
  const query = target.indexOf("?");
  url.pathname = query === -1 ? target : target.slice(0, query);
  url.search = query === -1 ? "" : target.slice(query);
  return url;
}

async function writeResponse(response: ServerResponse, result: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  result.headers.forEach((value, name) => {
    // set-cookie 必须逐条出站，Headers 的 forEach 会并成单值，单独走 getSetCookie
    if (name !== "set-cookie") {
      headers[name] = value;
    }
  });
  const setCookies = result.headers.getSetCookie();
  if (setCookies.length > 0) {
    headers["set-cookie"] = setCookies;
  }
  response.writeHead(result.status, headers);
  if (result.body === null) {
    response.end();
    return;
  }
  await pipeline(Readable.fromWeb(result.body), response);
}

@Injectable()
export class WebEngine implements WebEngineAdapter, OnContextClose {
  readonly name = "node";
  private server: Server | undefined;
  private stopping: Promise<void> | undefined;

  constructor(private readonly settings: WebNodeServeSettings) {}

  async start(application: WebApplication): Promise<WebApplicationHandle> {
    if (this.server !== undefined) {
      throw new Error("The Node.js web engine is already running.");
    }
    const dispatch = createRouter(application.routes, this.settings.maxParamLength);
    // 参数传递而不是实例字段：引擎是 start→close→start 可重启的（HMR），字段会跨轮次留着。
    const notFound = application.logNotFound;
    const server = createServer((request, response) => {
      // 写出期故障不在 PreparedRoute.handle 的"永不 reject"契约内（#226）：客户端读到一半断开时
      // pipeline 抛 ERR_STREAM_PREMATURE_CLOSE，没有这道 catch 它就是 unhandled rejection，
      // Node 默认行为是进程退出——任何客户端都能远程打崩服务。此时响应已无处可写，只能
      // 拆掉这条连接（destroy 对已销毁的响应是 no-op）。
      void this.serve(dispatch, notFound, request, response).catch(() => response.destroy());
    });
    this.server = server;
    // 主机名必须显式传给 listen（#323）：省略时 node 绑全接口，与 fastify 的缺省相反，同一份
    // 应用换引擎就换了暴露面。缺省值归 webEngineHostname 一处决定。
    const hostname = webEngineHostname(this.settings.hostname);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.settings.port, hostname, resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("The Node.js web engine must listen on a TCP address.");
    }
    // 地址经 handle 流出，不由引擎自己打（RFC 0011 L6/D2，#250）：三个引擎各写一行会得到
    // 三个不同前缀、绕过日志门面、也喂不进启动摘要。谁来说、说成什么样归框架统一决定。
    return {
      close: () => this.close(),
      address: webEngineAddress({ hostname, port: address.port }),
    };
  }

  onContextClose(): Promise<void> {
    // 幂等兜底：正常路径由 bootstrap 的关闭编排先走 handle.close（停止接新请求并排空
    // 在途请求，再进容器关闭序）；容器直接 close 时这里保证服务不会泄漏。
    return this.close();
  }

  private async serve(
    dispatch: ReturnType<typeof createRouter>,
    notFound: WebApplication["logNotFound"],
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const method = request.method ?? "GET";
    const url = requestUrl(request);
    if (url === undefined) {
      response.writeHead(400);
      response.end();
      return;
    }
    const outcome = dispatch(method, url.pathname);
    if (outcome.kind === "miss") {
      // 未命中与方法不符都是 404，不带 Allow（WebEngineAdapter 契约）
      response.writeHead(404);
      response.end();
      // 先答复再记账：日志晚一拍不影响客户端。url.pathname 就是原始请求目标去掉 query，
      // 正是 logNotFound 契约要的形状（RFC 0011 C7，#250）。
      notFound?.({ method, path: url.pathname });
      return;
    }
    // PreparedRoute.handle 契约保证永不 reject（@reforce/web/adapter），无需兜底
    const result = await outcome.route.handle(toRequest(request, method, url), outcome.params);
    await writeResponse(response, result);
    // server.close() 只等已登记的连接结束：响应发完后若正在关停，主动断开让 close 能
    // resolve（Node 不会替我们把"关停开始后才变空闲"的 keep-alive 连接关掉）。
    if (this.stopping !== undefined) {
      request.socket.destroy();
    }
  }

  private close(): Promise<void> {
    const server = this.server;
    if (server === undefined) {
      return Promise.resolve();
    }
    // 停新 → 排空：close() 立即停止接受新连接并等在途连接结束；closeIdleConnections()
    // 先收掉当前空闲的 keep-alive 连接，"响应完成后才空闲"的连接由 serve() 收尾处断开。
    const stopping =
      this.stopping ??
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeIdleConnections();
      }).then(() => {
        this.server = undefined;
      });
    this.stopping = stopping;
    return stopping;
  }
}
