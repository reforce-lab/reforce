import type { RequestScopeSeed } from "@reforce/core";
import type { IncomingRequest } from "@/execution/incoming-request";
import type { RequestContext } from "@/execution/request-context";
import type { RouteResponse } from "@/execution/route-response";
import type { RouteMarker } from "@/routing/route-marker";
import type { HttpMethod, RouteMetaValue } from "@/routing/vocabulary";

// 适配器契约（ADR 0006 W1/W2，#142 / #152）：与路由表 schema 一起版本化的公开面。引擎适配器
// 在启动时一次性消费 WebApplication（每条 PreparedRoute 已完成校验器/序列化器/链的组装），
// 把 method+path 灌进引擎原生注册面，热路径只调用 handle——框架抽象在热路径上不存在。
// 本 milestone 只定义契约与引擎无关执行；真实引擎适配器（@reforce/web-node，node:http）是 #153 与 #207。

export interface PreparedRoute {
  readonly method: HttpMethod;
  readonly path: string;
  // 引擎适配器的唯一每请求入口：内部依次完成 请求作用域开启（含播种）→ 洋葱链 → 校验 →
  // handler → 序列化 → 错误处理器兜底。永不 reject——一切错误在边界内换成响应。
  //
  // 返回的是内部货币 `RouteResponse`（#340），不是标准 `Response`：后者对 Uint8Array 源会
  // 强制建一条 ReadableStream，而引擎拿到之后第一件事就是把它拆回字节。适配器改为按
  // `body` 的实际形态分流即可，见下面的响应契约。
  //
  // 收 `IncomingRequest` 而不是标准 `Request`（#341）：后者逼着每个引擎在调用之前把原生请求
  // 整个翻译一遍（全量 Headers + new Request，实测约 1.5µs），而 `/health` 这类路由一个头都
  // 不读。`RequestContext.request` 仍然是标准 `Request`（ADR 0006 W3 不变），只是没人读就不造。
  handle(
    request: IncomingRequest,
    params: Readonly<Record<string, string>>,
  ): Promise<RouteResponse>;
  // 启动期按 marker 读路由元数据（#232），供引擎的 route customizer 决定这条路由要不要额外的引擎
  // 原生能力（限流配置、preHandler、约束…）。与 RouteMatch.meta 分工：这里是"注册前查一次"，
  // 那里是"每请求播种回调拿到的快照"。
  //
  // 写成方法而不是裸 record，是为了与 RequestContext.meta 同形：customizer 作者不用学两套
  // 写法，RouteMarker<T> 的 T 也能带过来；顺带不外露可变的表对象（生成物产出的是未冻结的
  // 对象字面量，引擎拿到就能改坏它）。
  meta<T extends RouteMetaValue>(marker: RouteMarker<T>): T | undefined;
}

export interface WebApplication {
  readonly routes: readonly PreparedRoute[];
  /**
   * 未命中上报（RFC 0011 C7，#250）。404 从不进入引擎无关执行层——每个引擎在自己的路由层
   * 就答复了——所以核心交出一个函数，而不是让三个引擎各自发明一份字段（同 L6 把请求日志
   * 收回核心的理由）。
   *
   * `path` 必须是**原始请求目标去掉 query**：不解码、不归一（`/users/%ZZ`、`//p` 原样传），
   * query 串永不进日志（里面有 token 与个人信息）。
   *
   * 缺席即没装日志绑定，引擎该整套机制都不装（不加钩子、不加中间件），零开销。
   *
   * 调它绝不影响响应：404 的响应体仍归引擎（见下面的响应契约），未命中也仍然不带 Allow。
   */
  readonly logNotFound?: (miss: { readonly method: string; readonly path: string }) => void;
}

// 响应出站的缓冲/流式判据（#232 → #340 改由类型承载）：判据不再是「有没有 content-length
// 这个头」，而是 `RouteResponse.body` 的**实际形态**——
//
// - `Uint8Array` / `string`：整体已在内存中，适配器必须走引擎原生直写（`res.end(body)` /
//   `reply.send(body)`），不得再包成流。etag、压缩这类需要完整体的能力因此可用。
// - `ReadableStream`：真流，适配器必须走桥接并保持背压。
// - `null`：空体。
//
// 这比看头可靠：头是可以写错的（handler 走逃生口时可以手写一个与实际字节不符的
// content-length，见 #346），而形态不会。
//
// 两条仍然成立的边界：
// 1. handler 直接返回的 raw Response 是逃生口，框架**吸收**它——读 status/headers，body 连
//    引用搬走且绝不消费。`new Response("ok")` 的 body 是 undici 造的流，因此仍走流式路径；
//    要非 JSON 又不想付流的成本，用 `respond()` 显式构造。
// 2. RFC 9110 规定 204/304 不得带 content-length，所以空体路径不写这个头。

// 引擎实际监听到的地址（RFC 0011 L6/D2，#250）。端口 0（临时端口）时这是唯一的实际端口
// 出口，所以它必须从引擎流出来，而不是由引擎自己打一行。
//
// 此前三个引擎各自 `process.stderr.write("[reforce.web-<name>] listening on …")`，三个不同
// 前缀、绕过日志门面、也喂不进启动摘要。引擎只报事实，谁来说、说成什么样归框架统一决定
// （同 L6 把请求日志收回核心的理由）。
export interface WebEngineAddress {
  /** 实际传给 listen 的主机名，即监听面本身；展示用的是 url，两者对通配地址不同（见下）。 */
  readonly hostname: string;
  readonly port: number;
  /** 拼好的可点击 URL；三个引擎拼法一致，免得各写各的又漂移。 */
  readonly url: string;
}

export interface WebApplicationHandle {
  close(): Promise<void>;
  /** 监听地址；不监听网络的引擎（测试替身）缺席。 */
  readonly address?: WebEngineAddress;
}

// 监听主机名的单一事实源（#323）。三个引擎"不配置 hostname"时的底层缺省互不相同（实测
// Node 26 / fastify 5.11）：node 与 hono 的 listen 不传 host 时绑全接口（`::`），fastify 缺省
// 绑 localhost（127.0.0.1）。也就是同一份应用配置换个引擎就换了暴露面，所以缺省不再交给
// 引擎——三个适配器都必须把本函数的返回值显式传进自己的 listen，不许再走"省略参数吃底层
// 缺省"那条路。
//
// 缺省 localhost 而不是全接口：dev 错误页（#279）带堆栈、源码框与请求上下文，绑全接口等于把
// 它交给同网段的任何人；浏览器侧还有 DNS rebinding——恶意页面把自家域名重绑到开发机的内网
// IP，绕过同源限制读 dev 服务的响应（Vite 因此把 server.host 的缺省改成 localhost）。生产也
// 缺省 localhost 是同一条原则的延伸：对外暴露是一个部署决定，得写出来，不该由"没配置"得到。
// 容器里监听全接口把 hostname 配成 `0.0.0.0` 或 `::` 即可，显式值一律照办、不做任何加工。
export function webEngineHostname(configured: string | undefined): string {
  return configured ?? "localhost";
}

// 通配地址不是能点开的地址：`::` 直接拼进 URL 还会拼出畸形的 `http://:::3000/`（authority 里
// 的裸 IPv6 必须加方括号），而启动摘要那一行是给人点的，e2e 也从里面抠 URL 做就绪探测。
// 监听面是全接口时，本机能到达它的名字就是 localhost（Vite 的 "Local:" 行同样这么显示）。
const wildcardHostnames = new Set(["0.0.0.0", "::"]);

function urlHostname(hostname: string): string {
  if (wildcardHostnames.has(hostname)) {
    return "localhost";
  }
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

/** 三个引擎共用的 URL 拼法，免得各写各的又漂移。hostname 传 webEngineHostname 的结果。 */
export function webEngineAddress(input: {
  readonly hostname: string;
  readonly port: number;
}): WebEngineAddress {
  return {
    hostname: input.hostname,
    port: input.port,
    url: `http://${urlHostname(input.hostname)}:${input.port}/`,
  };
}

// 引擎适配器要兑现的行为契约（#232）。这里只说结果，不规定用什么机制达成——各引擎的路由库能力
// 差别很大（find-my-way 有 ignoreDuplicateSlashes，hono 要自己写 getPath）。
//
// **路径归一**：`/p`、`/p/`、`//p` 必须视为同一路径。这不是对引擎生态的干涉，是 reforce
// 自己路由表语义的要求——`generated/validation.ts` 的重复路由检测已经假定了归一语义，引擎
// 不归一就会出现"编译期判为重复、运行时是两条路由"。
//
// **坏转义**：请求路径含非法 percent-escape（`/users/%ZZ`、截断的 `/users/%E0%A4%A`）时按
// 未命中处理，且解码异常不得逃逸出请求循环（逃逸的后果见 #211：响应永不写出，客户端挂到
// 超时）。注意契约不能写成"decodeURIComponent 失败即 404"——web-node 走的是 decodeURI 语义，
// `%2F` 在路径层保留（`/users/a%2Fb` → `id === "a/b"`），那条是既有契约。
//
// **方法不符 = 404**：不返回 405、不带 Allow 头。RFC 9110 §9.1 对 405 是 SHOULD 不是 MUST，
// Express / Fastify / Hono 默认也都不发 405。代价是 `OPTIONS /health` 变裸 404，预检交给引擎
// 生态的 cors 中间件——它跑在路由匹配之前。
//
// **未命中的响应体归引擎**：reforce 不统一 404 内容，各家格式不同是正常的。
export interface WebEngineAdapter {
  readonly name: string;
  start(application: WebApplication): Promise<WebApplicationHandle> | WebApplicationHandle;
}

// 每请求开启作用域 + 播种根请求 bean 的语义（ADR 0006 W7 / #151 的接线面）：播种目标必须是
// 应用图里已注册的 request bean，具体根 bean 由应用或 starter 决定，引擎无关核心不指定。
//
// 收 `RequestContext` 而不是 `(Request, RouteMatch)` 两个参数（#341）。原来的形状让惰性对
// **装了 seeder 的应用全部失效**：seeder 每请求必然被调用，第一个实参就逼着物化标准 Request，
// 实测 full 变体因此一点没快（min 变体同一轮快了 15%）。而绝大多数根请求 bean 只是把这两样
// 存起来，真正读的是 `context.url` 或某一个头。
//
// 顺带删掉 RouteMatch：method / path / params / meta 全在 context 上，它只是同一份事实的
// 第二个形状，还得每请求现造一个对象字面量。要标准 Request 的 seeder 照读 `context.request`
// 不误——只是这笔钱从"所有人默认付"变成"读的人才付"。
export type RequestSeeder = (context: RequestContext) => readonly RequestScopeSeed[];
