import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Injectable, type OnContextClose } from "@reforce/context";
import type { WebApplication, WebApplicationHandle, WebEngineAdapter } from "@reforce/web/adapter";
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
    const dispatch = createRouter(application.routes);
    const server = createServer((request, response) => {
      void this.serve(dispatch, request, response);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      if (this.settings.hostname === undefined) {
        server.listen(this.settings.port, resolve);
      } else {
        server.listen(this.settings.port, this.settings.hostname, resolve);
      }
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("The Node.js web engine must listen on a TCP address.");
    }
    // 监听地址走 stderr：端口 0（临时端口）时这是唯一的实际端口出口，但 stdout 属于应用
    // 数据面（生成的 bootstrap 会被当作库嵌入 Worker/管道消费，stdout 必须保持纯净），
    // 运维日志与 @reforce/config 的 console.warn 同走 stderr。
    process.stderr.write(
      `[reforce.web-node] listening on http://${this.settings.hostname ?? "localhost"}:${address.port}/\n`,
    );
    return { close: () => this.close() };
  }

  onContextClose(): Promise<void> {
    // 幂等兜底：正常路径由 bootstrap 的关闭编排先走 handle.close（停止接新请求并排空
    // 在途请求，再进容器关闭序）；容器直接 close 时这里保证服务不会泄漏。
    return this.close();
  }

  private async serve(
    dispatch: ReturnType<typeof createRouter>,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const outcome = dispatch(method, url.pathname);
    if (outcome.kind === "miss") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (outcome.kind === "method-mismatch") {
      response.writeHead(405, { allow: outcome.allowed.join(", ") });
      response.end();
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
