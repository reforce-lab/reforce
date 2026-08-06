import type { RequestScopeSeed } from "@reforce/context";
import type { RouteMarker } from "@/routing/route-marker";
import type { HttpMethod, RouteMetaValue } from "@/routing/vocabulary";

// 适配器契约（ADR 0006 W1/W2，#142 / #152）：与路由表 schema 一起版本化的公开面。引擎适配器
// 在启动时一次性消费 WebApplication（每条 PreparedRoute 已完成校验器/序列化器/链的组装），
// 把 method+path 灌进引擎原生注册面，热路径只调用 handle——框架抽象在热路径上不存在。
// 本 milestone 只定义契约与引擎无关执行；真实引擎适配器（@reforce/web-node，node:http）是 #153 与 #207。

export interface RouteMatch {
  readonly method: HttpMethod;
  // 路由模式（如 /users/:id）与本次匹配出的原始路径参数。
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly meta: Readonly<Record<string, RouteMetaValue>>;
}

export interface PreparedRoute {
  readonly method: HttpMethod;
  readonly path: string;
  // 引擎适配器的唯一每请求入口：内部依次完成 请求作用域开启（含播种）→ 洋葱链 → 校验 →
  // handler → 序列化 → 错误处理器兜底。永不 reject——一切错误在边界内换成 Response。
  handle(request: Request, params: Readonly<Record<string, string>>): Promise<Response>;
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
}

// 响应出站的缓冲/流式判据（#232）：`handle` 返回的 Response 带 `content-length` 即"整体已在内存中、
// 可安全缓冲"，适配器可以走 Buffer 路径（etag、压缩这类需要完整体的能力因此可用）；不带即
// 按流式处理，适配器必须走流并保持背压。三条边界一起看才不会把措辞说过头：
//
// 1. handler 直接返回的 raw Response 自己带 `content-length` 是合法的，语义同样成立——不得
//    理解成"带 = 由 reforce 序列化产生"。
// 2. raw Response 有完整体却不带该头（`new Response("ok")`、`Response.json(x)` 都不自动带）
//    只损失优化，不损失正确性。
// 3. 适配器以该头的**存在**为信号，出站长度以实际字节为准，**不得信任 handler 手写的数值**。
//
// 另：RFC 9110 规定 204/304 不得带该头，所以契约不是"所有完整体响应都必须带"。

// 引擎实际监听到的地址（RFC 0011 L6/D2，#250）。端口 0（临时端口）时这是唯一的实际端口
// 出口，所以它必须从引擎流出来，而不是由引擎自己打一行。
//
// 此前三个引擎各自 `process.stderr.write("[reforce.web-<name>] listening on …")`，三个不同
// 前缀、绕过日志门面、也喂不进启动摘要。引擎只报事实，谁来说、说成什么样归框架统一决定
// （同 L6 把请求日志收回核心的理由）。
export interface WebEngineAddress {
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

/** 三个引擎共用的 URL 拼法：缺省主机名是 localhost，与此前三条 stderr 行逐字一致。 */
export function webEngineAddress(input: {
  readonly hostname?: string;
  readonly port: number;
}): WebEngineAddress {
  const hostname = input.hostname ?? "localhost";
  return { hostname, port: input.port, url: `http://${hostname}:${input.port}/` };
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
export type RequestSeeder = (request: Request, match: RouteMatch) => readonly RequestScopeSeed[];
