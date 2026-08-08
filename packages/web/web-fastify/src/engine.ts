import type { IncomingMessage, Server } from "node:http";
import { Readable } from "node:stream";
import { Injectable, type OnContextClose } from "@reforce/core";
import type {
  PreparedRoute,
  WebApplication,
  WebApplicationHandle,
  WebEngineAdapter,
} from "@reforce/web-core/adapter";
import { webEngineAddress, webEngineHostname } from "@reforce/web-core/adapter";
import Fastify, { type FastifyInstance, type FastifyReply, type RouteOptions } from "fastify";
import {
  type FastifyConfigurer,
  type FastifyRouteCustomizer,
  reservedRouteOptionKeys,
} from "@/bridges";
import { requestUrl, toRequest } from "@/request";
import type { WebFastifyServeSettings } from "@/settings";

// fastify 引擎适配器（#238）：reforce 的路由处理函数就是一个普通的 fastify handler，走 fastify 正常的
// 响应通道（reply.send），不 hijack、也不直接 return 标准 Response。两条反面路线都实测过：
//
// - **hijack**：onSend 不跑 → @fastify/compress 完全失效（1600B 原样出站 vs 正确路线 41B），
//   生态只剩 onRequest 那一半。
// - **直接 return new Response(...)**：fastify 5 原生支持，但 unwrap 发生在所有 onSend 之后
//   ——钩子看到 statusCode 恒为 200、头全空、payload 是 `[object Response]`；且
//   @fastify/compress + 无 body 的 204/304 直接 500（只要客户端发了 accept-encoding 就触发，
//   即所有浏览器）。
//
// 所以走"显式搬运"：状态码、头、set-cookie 逐条搬到 reply 上，body 按 content-length 选
// Buffer / 流。

function bodyOf(result: Response): Promise<Buffer> | Readable | null {
  if (result.body === null) {
    return null;
  }
  // content-length 是 WebEngineAdapter 契约的缓冲/流式判据（见 adapter.ts）：带它即"整体已在
  // 内存中、可安全缓冲"，走 Buffer 路径让 etag / 压缩这类需要完整体的能力可用；不带即流式，
  // 必须走流并保持背压。以该头的**存在**为信号，长度以实际字节为准——不信任写进来的数值。
  if (result.headers.get("content-length") !== null) {
    return result.arrayBuffer().then((bytes) => Buffer.from(bytes));
  }
  return Readable.fromWeb(result.body);
}

async function transfer(reply: FastifyReply, result: Response): Promise<FastifyReply> {
  reply.code(result.status);
  result.headers.forEach((value, name) => {
    // set-cookie 必须逐条出站，Headers 的 forEach 会并成单值，单独走 getSetCookie
    if (name !== "set-cookie") {
      reply.header(name, value);
    }
  });
  const setCookies = result.headers.getSetCookie();
  if (setCookies.length > 0) {
    reply.header("set-cookie", setCookies);
  }
  const body = bodyOf(result);
  return reply.send(body === null ? undefined : await body);
}

// 两个上报点共用一份取值（RFC 0011 C7，#250）：契约要求 path 是原始请求目标去掉 query，
// 而 fastify 的 request.url 与 find-my-way 交给 onBadUrl 的 path 都带着 query。Host 头畸形时
// requestUrl 返回 undefined，没有可信路径可报——这条宁可不记，也不把带 query 的原串当路径记。
function reportMiss(
  notFound: NonNullable<WebApplication["logNotFound"]>,
  raw: IncomingMessage,
): void {
  const path = requestUrl(raw)?.pathname;
  if (path === undefined) {
    return;
  }
  notFound({ method: raw.method ?? "GET", path });
}

// customizer 返回的选项不得覆盖 reforce 的注册面（被改写就是静默错路由），也不得覆盖
// schema.response（fast-json-stringify 会插进序列化路径，与 @reforce/web-core 的白名单投影双重
// 裁剪，结果不可预测）。硬错而非静默丢弃：静默丢弃会让用户以为定制生效了。
function mergeRouteOptions(
  route: PreparedRoute,
  customized: readonly Partial<RouteOptions>[],
): Partial<RouteOptions> {
  const merged: Record<string, unknown> = {};
  for (const options of customized) {
    for (const [key, value] of Object.entries(options)) {
      if ((reservedRouteOptionKeys as readonly string[]).includes(key)) {
        throw new Error(
          `A Fastify route customizer may not override "${key}" on ${route.method} ${route.path}; it is Reforce's own registration surface.`,
        );
      }
      if (key === "schema" && Object.hasOwn(Object(value), "response")) {
        throw new Error(
          `A Fastify route customizer may not set schema.response on ${route.method} ${route.path}; Reforce owns response serialization.`,
        );
      }
      merged[key] = value;
    }
  }
  return merged;
}

@Injectable()
export class WebEngine implements WebEngineAdapter, OnContextClose {
  readonly name = "fastify";
  private app: FastifyInstance | undefined;
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly settings: WebFastifyServeSettings,
    // 两座桥经构造器集合注入到达：0 个 / 1 个 / N 个都合法（空集合是合法的集合注入，
    // 不是 MISSING_BEAN）。成员顺序由编译期的 @Order + beanId 决定。
    private readonly configurers: readonly FastifyConfigurer[],
    private readonly routeCustomizers: readonly FastifyRouteCustomizer[],
  ) {}

  async start(application: WebApplication): Promise<WebApplicationHandle> {
    if (this.app !== undefined) {
      throw new Error("The Fastify web engine is already running.");
    }
    // 实例必须在 start 里造，不能在构造函数里：fastify 实例单次可用，close 之后再 listen 抛
    // FST_ERR_REOPENED_CLOSE_SERVER。HMR 的 start→close→start 循环因此必须每轮重建。
    const app = this.createInstance(application.logNotFound);
    // 关停收尾：fastify 的 close 确实会等在途请求结束（实测），但**不会**收掉"关停开始后才
    // 变空闲"的 keep-alive 连接——`forceCloseConnections: "idle"` 与 `closeIdleConnections()`
    // 都只处理调用那一刻已空闲的连接，实测两者都让 close 永远挂着。
    //
    // socket 必须在 request 事件里就抓住：到 onResponse / res 的 finish 时 `reply.raw.socket`
    // 已经是 null（实测打印为 false），照着它 destroy 等于什么都没做。
    app.server.on("request", (request, response) => {
      const socket = request.socket;
      response.on("finish", () => {
        if (this.stopping !== undefined) {
          socket.destroy();
        }
      });
    });
    await this.configure(app, application);
    this.app = app;
    // 主机名必须显式传给 listen（#323）：省略时 fastify 缺省绑 localhost，而 node/hono 省略时
    // 绑全接口，同一份应用换引擎就换了暴露面。缺省值归 webEngineHostname 一处决定。
    const hostname = webEngineHostname(this.settings.hostname);
    await app.listen({ port: this.settings.port, host: hostname });
    const address = (app.server as Server).address();
    if (address === null || typeof address === "string") {
      throw new Error("The Fastify web engine must listen on a TCP address.");
    }
    // 地址经 handle 流出，不由引擎自己打（RFC 0011 L6/D2，#250）：三个引擎各写一行会得到
    // 三个不同前缀、绕过日志门面、也喂不进启动摘要。谁来说、说成什么样归框架统一决定。
    return {
      close: () => this.close(),
      address: webEngineAddress({ hostname, port: address.port }),
    };
  }

  onContextClose(): Promise<void> {
    // 幂等兜底：正常路径由 bootstrap 的关闭编排先走 handle.close，容器直接 close 时这里保证
    // 服务不泄漏。
    return this.close();
  }

  private createInstance(notFound: WebApplication["logNotFound"]): FastifyInstance {
    return Fastify({
      // exposeHeadRoutes 必须关掉（#238），两个理由：
      //
      // 1. 开着的话 fastify 会给每条 GET 自动补一条 HEAD，而 reforce 允许同一路径上同时写
      //    @Get 与 @Head——两者相撞，启动期直接 FST_ERR_DUPLICATED_ROUTE（实测）。一份合法的
      //    reforce 应用因此在 fastify 上起不来。
      // 2. 关掉之后的语义与 web-node 逐条对齐（实测）：GET-only 路径上的 HEAD → 404，
      //    显式 @Head 路由 → 200。开着反而让 fastify 与其它引擎不一致，"换引擎零改动"就破了。
      //
      // 想要"GET 自动带 HEAD"的用户在 configurer 里自行开启，那是他们对自己应用的判断。
      exposeHeadRoutes: false,
      // 这三项是构造期选项，configurer 来不及改（initialConfig 是冻结的）。
      // maxParamLength 的默认值 fastify 是 100、web-node 是不限制，必须显式对齐，否则同一份
      // 应用换到 fastify 上会把长参数请求静默变成 404。
      // 5.11 起顶层传这些会打 FSTDEP022，必须写成 routerOptions。
      routerOptions: {
        ignoreTrailingSlash: true,
        ignoreDuplicateSlashes: true,
        maxParamLength: this.settings.maxParamLength ?? Number.MAX_SAFE_INTEGER,
        // onBadUrl 是 raw 通道（签名 (path, IncomingMessage, ServerResponse)，没有 Reply），
        // 只能手写 writeHead，绕过所有钩子。契约要求坏转义按未命中处理，所以是 404 不是 400。
        // 更阴的是它**只对已注册过路由的方法**触发：GET /users/%ZZ 走这里，而 POST /users/%ZZ
        // （无 POST 路由）落 notFoundHandler——两条路径都得是 404，后者用 fastify 的默认行为。
        onBadUrl: (_path, raw, response) => {
          response.writeHead(404);
          response.end();
          // 这条 404 走 raw 通道、绕过所有钩子（实测只触发 onBadUrl，onRequest/onResponse
          // 都不来），未命中日志因此只能在这里发。
          if (notFound !== undefined) {
            reportMiss(notFound, raw);
          }
        },
      },
      ...(this.settings.bodyLimit === undefined ? {} : { bodyLimit: this.settings.bodyLimit }),
      // fastify 自带日志，原样递出不做翻译（RFC 0011 L8，#242）。缺省不写这两个键——写
      // `logger: undefined` 与不写在 fastify 那里不等价，前者会盖掉它自己的缺省判定。
      ...(this.settings.logger === undefined ? {} : { logger: this.settings.logger }),
      ...(this.settings.disableRequestLogging === undefined
        ? {}
        : { disableRequestLogging: this.settings.disableRequestLogging }),
    });
  }

  private async configure(app: FastifyInstance, application: WebApplication): Promise<void> {
    // 自装 buffer parser，把 body 原样交给 reforce。放任 fastify 默认解析的代价（实测）是把
    // 一整类 4xx 挪出 reforce 洋葱：畸形 JSON → FST_ERR_CTP_INVALID_JSON_BODY、空 body →
    // FST_ERR_CTP_EMPTY_JSON_BODY、未知 content-type → 415，三者都不经 observability 中间件、
    // 不经 reforce 的错误处理器。改用 buffer parser 后全部进 reforce，bodyLimit 仍生效。
    //
    // 副作用：@fastify/formbody 与 @fastify/multipart 变成**冗余**而非不可用——标准
    // Request.formData() 原生覆盖两者。
    app.removeAllContentTypeParsers();
    // 用 "*" 这个 catch-all 而不是 /.*/：正则形态会触发 fastify 的 FSTSEC001 警告（它按
    // essence MIME type 检测，无锚点的正则被认为可能被 CORS 攻击绕过）。
    app.addContentTypeParser<Buffer>("*", { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body),
    );
    // 只观察不接管（RFC 0011 C7，#250）：用 onResponse 而不是 setNotFoundHandler——后者会换掉
    // 404 的响应体（契约里那个 body 归引擎），而且它每实例只有一个槽位，reforce 占了之后用户
    // configurer 自己调 setNotFoundHandler 就变成启动硬错。全局钩子够得到 404 路由：fastify
    // 在 preReady 时把它们拷进 404 上下文，所以注册顺序与 configurer 无关。
    //
    // 留了一个洞，明写出来免得被当成漏改：**没有任何已注册路由的方法**上的坏转义
    // （POST /users/%ZZ）由 fastify 的 basic404 在钩子链之外答复，报不上来。
    const notFound = application.logNotFound;
    if (notFound !== undefined) {
      app.addHook("onResponse", (request, reply, done) => {
        if (request.is404 && reply.statusCode === 404) {
          reportMiss(notFound, request.raw);
        }
        done();
      });
    }
    for (const configurer of this.configurers) {
      await configurer.configure(app);
    }
    for (const route of application.routes) {
      app.route({
        ...mergeRouteOptions(
          route,
          this.routeCustomizers.flatMap((customizer) => customizer.customize(route) ?? []),
        ),
        method: route.method,
        url: route.path,
        handler: async (request, reply) => {
          const url = requestUrl(request.raw);
          if (url === undefined) {
            return await reply.code(400).send();
          }
          // PreparedRoute.handle 契约保证永不 reject（@reforce/web-core/adapter），无需兜底
          const result = await route.handle(
            toRequest(request.raw, url, request.body),
            request.params as Readonly<Record<string, string>>,
          );
          return await transfer(reply, result);
        },
      });
    }
  }

  private close(): Promise<void> {
    const app = this.app;
    if (app === undefined) {
      return Promise.resolve();
    }
    // fastify 的 close 自己排空在途请求、幂等、且不被空闲 keep-alive 连接拖住（实测比
    // web-node 省掉 socket.destroy() 收尾）。实例单次可用，所以这里把引用丢掉，下次 start
    // 重建。
    if (this.stopping !== undefined) {
      return this.stopping;
    }
    // stopping 必须先于 close() 落位：上面那个 finish 监听靠它判断要不要拆连接。
    const stopping = Promise.resolve().then(async () => {
      await app.close();
      this.app = undefined;
      this.stopping = undefined;
    });
    this.stopping = stopping;
    // 先收掉此刻已空闲的 keep-alive 连接；"关停后才变空闲"的那些由 finish 监听收尾。
    app.server.closeIdleConnections();
    return stopping;
  }
}
