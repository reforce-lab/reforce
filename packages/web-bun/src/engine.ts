import { Injectable, type OnContextClose } from "@reforce/context";
import type { WebApplication, WebApplicationHandle, WebEngineAdapter } from "@reforce/web";
import type { BunRequest, Server } from "bun";
import { createFallbackResponder } from "@/routing-fallback";
import type { WebBunServeSettings } from "@/settings";

// Bun 引擎适配器（ADR 0006 W1/W2，#142 / #153）：启动时一次性把 PreparedRoute 灌进
// Bun.serve 的原生 routes 静态表（方法表 + 参数路由），热路径上路由分发全部由 Bun 原生
// 完成，框架的活只剩每请求调用 route.handle（作用域开启→播种→洋葱链→兜底都在其内部）。
// 未命中原生表的请求才进 fetch fallback（冷路径），在那里区分 404 与 405。

type BunRouteHandler = (request: BunRequest) => Promise<Response>;

function nativeRoutes(
  routes: readonly WebApplication["routes"][number][],
): Record<string, Record<string, BunRouteHandler>> {
  const byPath: Record<string, Record<string, BunRouteHandler>> = {};
  for (const route of routes) {
    const methods = byPath[route.path] ?? {};
    byPath[route.path] = methods;
    methods[route.method] = (request) => route.handle(request, request.params);
  }
  return byPath;
}

@Injectable()
export class WebEngine implements WebEngineAdapter, OnContextClose {
  readonly name = "bun";
  private server: Server<unknown> | undefined;
  private stopping: Promise<void> | undefined;

  constructor(private readonly settings: WebBunServeSettings) {}

  start(application: WebApplication): WebApplicationHandle {
    if (this.server !== undefined) {
      throw new Error("The Bun web engine is already running.");
    }
    const server = Bun.serve({
      port: this.settings.port,
      ...(this.settings.hostname === undefined ? {} : { hostname: this.settings.hostname }),
      routes: nativeRoutes(application.routes),
      fetch: createFallbackResponder(application.routes),
    });
    this.server = server;
    // 监听地址走 stderr：端口 0（临时端口）时这是唯一的实际端口出口，但 stdout 属于应用
    // 数据面（生成的 bootstrap 会被当作库嵌入 Worker/管道消费，stdout 必须保持纯净），
    // 运维日志与 @reforce/config 的 console.warn 同走 stderr。
    process.stderr.write(`[reforce.web-bun] listening on ${server.url.href}\n`);
    return { close: () => this.close() };
  }

  onContextClose(): Promise<void> {
    // 幂等兜底：正常路径由 bootstrap 的关闭编排先走 handle.close（停止接新请求并排空
    // 在途请求，再进容器关闭序）；容器直接 close 时这里保证服务不会泄漏。
    return this.close();
  }

  private close(): Promise<void> {
    const server = this.server;
    if (server === undefined) {
      return Promise.resolve();
    }
    // Bun 的 server.stop()：立即停止接受新连接，在途请求全部完成后才 resolve——
    // 正是"停新→排空"的原生表达（#153 spike 实测确认）。
    const stopping =
      this.stopping ??
      server.stop().then(() => {
        this.server = undefined;
      });
    this.stopping = stopping;
    return stopping;
  }
}
