import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Injectable, type OnContextClose } from "@reforce/context";
import type { WebApplication, WebApplicationHandle, WebEngineAdapter } from "@reforce/web/adapter";
import { Hono } from "hono";
import { TrieRouter } from "hono/router/trie-router";
import type { HonoConfigurer, HonoRouteCustomizer } from "@/bridges";
import { honoRequestPath } from "@/path";
import { orderRoutesForHono } from "@/route-order";
import type { WebHonoServeSettings } from "@/settings";

// hono 引擎适配器（#236）：reforce 的路由处理函数就是一个普通的 hono handler，不绕过 hono 的任何通道。
//
//   hono 生态中间件（cors / helmet / compress / rate-limit / static）
//    └─ hono 路由匹配（未命中 → hono 自己的 404，reforce 不接管）
//        └─ reforce handler ── 直接 return 标准 Response（hono 原生用法）
//
// 因此外层 `app.use('*')` 的 `await next()` 之后既能改头也能整体替换 c.res，生态中间件按它们
// 本来的方式工作。reforce 只提供两座桥（应用级 configurer、路由级 customizer），其余不碰。
//
// **TrieRouter 是钉死的，不是默认值**：RegExpRouter 遇到 `/users/:id` + `/users/self` 直接抛
// UnsupportedPathError（实测），而 SmartRouter 会在**第一个请求**时才静默回退到 TrieRouter，
// 启动期看不出来。代价是放弃 hono 的性能招牌，换来启动即确定的行为。

@Injectable()
export class WebEngine implements WebEngineAdapter, OnContextClose {
  readonly name = "hono";
  private server: Server | undefined;
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly settings: WebHonoServeSettings,
    // 两座桥经构造器集合注入到达：0 个 / 1 个 / N 个都合法（空集合是合法的集合注入，
    // 不是 MISSING_BEAN）。成员顺序由编译期的 @Order + beanId 决定。
    private readonly configurers: readonly HonoConfigurer[],
    private readonly routeCustomizers: readonly HonoRouteCustomizer[],
  ) {}

  async start(application: WebApplication): Promise<WebApplicationHandle> {
    if (this.server !== undefined) {
      throw new Error("The Hono web engine is already running.");
    }
    const app = await this.buildApplication(application);
    const server = serve({
      fetch: app.fetch,
      port: this.settings.port,
      ...(this.settings.hostname === undefined ? {} : { hostname: this.settings.hostname }),
    }) as Server;
    // 关停收尾：server.close() 只等已登记的连接结束，"关停开始后才变空闲"的 keep-alive 连接
    // Node 不会替我们收掉（web-node 同样要这一步）。
    //
    // 这件事**不能**放进 hono 中间件的 await next() 之后：那里拿到的是 Response 对象刚被
    // 返回的时刻，不是响应体流完的时刻（洋葱与流式的固有冲突）。实测放在中间件里会在流式
    // 响应写到一半时拆掉连接，排空语义直接失效。响应的 finish 事件才是"字节已全部送出"。
    server.on("request", (_request, response) => {
      response.on("finish", () => {
        if (this.stopping !== undefined) {
          response.socket?.destroy();
        }
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("The Hono web engine must listen on a TCP address.");
    }
    // 监听地址走 stderr（同 web-node）：端口 0 时这是唯一的实际端口出口，而 stdout 属于应用
    // 数据面，生成的 bootstrap 会被当作库嵌入 Worker/管道消费。
    process.stderr.write(
      `[reforce.web-hono] listening on http://${this.settings.hostname ?? "localhost"}:${address.port}/\n`,
    );
    return { close: () => this.close() };
  }

  onContextClose(): Promise<void> {
    // 幂等兜底：正常路径由 bootstrap 的关闭编排先走 handle.close，容器直接 close 时这里保证
    // 服务不泄漏。
    return this.close();
  }

  private async buildApplication(application: WebApplication): Promise<Hono> {
    const app = new Hono({ router: new TrieRouter(), getPath: honoRequestPath });
    // configurer 必须全部跑在 app.on 之前：hono 的 app.use 只对**之后**注册的路由生效，
    // 装晚了静默无效（实测）。
    for (const configurer of this.configurers) {
      await configurer.configure(app);
    }
    for (const route of orderRoutesForHono(application.routes)) {
      // customizer 的中间件逐条 on 上去，而不是 `on(method, path, ...middleware, handler)`：
      // hono 的 on 类型面是固定元数的重载表，变长 spread 匹配不到任何一条。同一 method+path
      // 上连续 on 的 handler 由 hono 自己按注册顺序 compose（实测 mw1:in → mw2:in → handler
      // → mw2:out → mw1:out），且只对该 method 生效——语义与一次传多个完全一致，还省掉重写
      // 一份 compose。
      for (const customizer of this.routeCustomizers) {
        for (const middleware of customizer.customize(route) ?? []) {
          app.on(route.method, route.path, middleware);
        }
      }
      app.on(route.method, route.path, (context) =>
        route.handle(context.req.raw, context.req.param()),
      );
    }
    return app;
  }

  private close(): Promise<void> {
    const server = this.server;
    if (server === undefined) {
      return Promise.resolve();
    }
    const stopping =
      this.stopping ??
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeIdleConnections();
      }).then(() => {
        this.server = undefined;
        this.stopping = undefined;
      });
    this.stopping = stopping;
    return stopping;
  }
}
