// 内部响应货币（#340）。
//
// 此前编码/序列化产出的每一条响应都先造一个标准 `Response`，再由引擎拆开搬运。实测这一步
// 单独占 min-fastify 忙时 CPU 的四分之一（undici 14.9% + web streams 5.8%）——`new Response`
// 对 `Uint8Array` 源会立刻建一条 ReadableStream，而两个引擎拿到之后第一件事就是把它拆回字节。
// 造了拆、拆了造。对照证据：`@hono/node-server` 把 `global.Response` 换成自家轻量实现，同一份
// 核心代码在 hono 引擎上 web streams 直接归零、快三分之一。
//
// 所以框架自己的管道改传这个 plain object，标准 `Response` 收缩成两处：用户主动构造的逃生口
// （RFC 0012 #264 决策 7），以及用户读 `context.request` 时的请求侧。
//
// **body 保持它本来的形态**，不做归一：引擎据此分流——已知长度的字节/字符串走原生直写
// （`res.end(body)` / `reply.send(body)`），只有真的是流才走桥接。这正是 `adapter.ts` 里
// content-length 判据想表达的事，现在它由类型本身承载，不必再靠一个头去猜。

import type { RequestContextState } from "@/execution/request-context";
import type { ResponseHeaders } from "@/execution/response-headers";

/** 出站体的四种形态。前三种是「整体已在内存中」，最后一种才要流式桥接。 */
export type ResponseBody = Uint8Array | string | ReadableStream<Uint8Array> | null;

export interface RouteResponse {
  /**
   * 把标准 `Response` 挡在类型层之外。**运行时不存在这个属性**，零开销。
   *
   * 没有它的话 `Response` 会**结构上**满足本接口（status: number、headers: Headers、
   * body: ReadableStream | null 全都对得上），于是旧签名的中间件
   * `next: () => Promise<Response>` 照常编译通过，而 `await next()` 拿到的运行时是个 plain
   * object——用户一调 `.json()` 就炸。类型说是 Response、实际不是，这是最坏的一种破坏：
   * 静默。`Response.ok` 是 `boolean`，不能赋给 `never | undefined`，因此这一行把它变成
   * 编译期错误。框架自己造的字面量不写这个键，可选属性照常通过。
   */
  readonly ok?: never;
  readonly status: number;
  /**
   * 响应头。这**就是** `RequestContext.responseHeaders` 那一个实例（#340 决议 2）：
   * 序列化器把 content-type / content-length 直接写进去，handler 与中间件写的也是它，
   * 因此不存在两份头需要合并——`mergeResponseHeaders` 连同它那条「哪些响应合、哪些不合」
   * 的例外规则一起被删掉了。
   *
   * 行为后果要明写：写在 context 上的响应头现在**一定**出站，包括错误响应与逃生口。
   * 这是有意的语义收敛（取代 RFC 0012 S3 / #275 拍板 3），一条无例外的规则胜过一条带例外的。
   */
  readonly headers: ResponseHeaders;
  readonly body: ResponseBody;
}

/**
 * 显式构造一条响应。handler 与中间件需要完全掌控状态码/头/体时用它，取代「为了这个只好
 * `return new Response(...)`」——后者会真的造出一个标准对象连带一条流。
 *
 * 头写进传入的 `headers`（即 context 那一个实例），不新建。
 */
export function respond(
  headers: ResponseHeaders,
  status: number,
  body: ResponseBody = null,
): RouteResponse {
  return { status, headers, body };
}

/**
 * 把标准 `Response` 转成内部货币。框架在逃生口自动做这件事（handler、中间件、错误处理器三处
 * 出口），公开出来是给**自建 harness 与测试替身**用：它们直接扮演 `PreparedRoute.handle`，
 * 绕过了框架那一步，语义必须一致——set-cookie 逐条 append、其余 set、body 不消费。各写一遍
 * 必然漂移。
 */
// 逃生口的吸收（#340）：用户自己造的标准 `Response` 原样透传语义不变——不投影、不盖状态码、
// **不消费 body**。这里只读它的 status 与 headers，body 连引用一起搬走；真是流就仍然是流，
// 引擎照常走桥接并保持背压。
//
// 头的方向：用户 Response 上的头压过 context 上已有的同名头——那个对象是调用点最具体的
// 表达。set-cookie 例外，必须逐条 append（Headers 迭代会把同名并成逗号串，而逗号串会被
// 浏览器当成一条 cookie）。
export function absorbResponse(response: Response, headers: ResponseHeaders): RouteResponse {
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") {
      continue;
    }
    headers.set(name, value);
  }
  for (const cookie of response.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return { status: response.status, headers, body: response.body };
}

/** 中间件与错误处理器两处出口都收这个联合：内部货币，或用户的逃生口。 */
export type RouteOutcome = RouteResponse | Response;

export function toRouteResponse(
  outcome: RouteOutcome,
  context: RequestContextState,
): RouteResponse {
  return outcome instanceof Response ? absorbResponse(outcome, context.responseHeaders) : outcome;
}

/**
 * 把 `RouteResponse` 的体读成字符串。
 *
 * 这是公开 API 而不是测试工具：框架既然把内部货币交到用户手上（中间件的 `next()` 返回值、
 * 错误处理器拿到的东西），就得给出读它的办法——否则每个人都要自己写一遍这个三分支。
 * body 保持原形态是为了让引擎按形态分流，归一成字符串是**读**的时候才需要的事。
 *
 * 流形态会被消费掉：同一个 `RouteResponse` 不要读第二次，也不要读了之后再交回给引擎。
 */
export async function readRouteBody(response: RouteResponse): Promise<string> {
  const { body } = response;
  if (body === null) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  const decoder = new TextDecoder();
  if (body instanceof Uint8Array) {
    return decoder.decode(body);
  }
  let text = "";
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
