// 引擎交给核心的每请求入口对象（#341）。
//
// 此前 `PreparedRoute.handle` 直接收一个标准 `Request`，于是每个引擎在调它之前必须先把
// 原生请求整个翻译一遍：`Object.entries(headersDistinct)` 全量展开、逐条 `headers.append()`
// （每条还要过一遍 WebIDL 的 ByteString 校验），再 `new Request(url, init)`。实测约 1.5µs，
// 而 `GET /health` 这类路由一个请求头都不读——这份工作的产出被整个丢弃。
//
// 光「惰性造 Request」不够。真正逼着物化的是框架自己：`resolveRequestId` 每请求要读一次
// `x-request-id`（#303 的开箱件，零配置默认开）。hono 的 Request 早就是惰性 Proxy 了，
// 仍然被这一下读成全量 Headers——profile 里 web-hono 的 undici 桶因此还占 9.4%，热点是
// `webidl.converters.HeadersInit` / `append` / `ByteString`。
//
// 所以接口的关键不是 `standard()`，是 `header()`：**能便宜地回答单个头**，不建 Headers。
export interface IncomingRequest {
  readonly method: string;
  /**
   * 请求 URL。**引擎若为路由匹配已经解析过一次，就把那一个实例交出来**——此前核心还会再
   * `new URL(request.url)` 解析同一个字符串一次，纯重复。没解析过的引擎（hono 的路由走字符串
   * 匹配）按需解析并自行缓存。
   */
  url(): URL;
  /**
   * 按名取头，大小写不敏感。同名多值按 HTTP 语义并成逗号串（`set-cookie` 除外，但框架内部
   * 不从请求侧读它）。实现必须直接查引擎原生对象，**不得**为此构造 `Headers`。
   */
  header(name: string): string | null;
  /**
   * 物化成标准 `Request`。`RequestContext.request` 走它（ADR 0006 W3 的承诺不变：用户拿到的
   * 就是标准对象），没人读就永远不造。实现必须缓存——同一请求内多次读 `context.request`
   * 必须是同一个实例，否则 body 会被重复消费。
   */
  standard(): Request;
}

/**
 * 从一个已经造好的标准 `Request` 得到 `IncomingRequest`。
 *
 * 框架自己的引擎适配器**不用**它——它们的整个价值就是不造那个 Request。这个函数是给
 * 已经手里有 Request 的调用方用的：测试替身、自建 harness，以及少数把请求从别处接过来的
 * 场景。`header()` 在这里只能走 `headers.get()`，也就是说物化已经发生过了，省不回来。
 */
export function fromStandardRequest(request: Request): IncomingRequest {
  let parsed: URL | undefined;
  return {
    method: request.method,
    url: () => {
      parsed ??= new URL(request.url);
      return parsed;
    },
    header: (name) => request.headers.get(name),
    standard: () => request,
  };
}
