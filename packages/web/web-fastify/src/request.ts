import type { IncomingMessage } from "node:http";
import type { IncomingRequest } from "@reforce/web-core";

// 请求 URL 的 authority 只能来自 Host 头，路径与查询按"路径"赋值而不是按"URL 引用"解析。
// 与 web-node 的 requestUrl 是同一段逻辑、同一个理由（#226）：请求目标是请求方完全控制的
// 字符串，`new URL("//evil.com/health", base)` 会走 WHATWG 的 protocol-relative 分支把 host
// 换成 evil.com，handler 拿 context.url.origin 拼跳转就此成为开放重定向。
//
// 两处各留一份而不是抽公共包：只有两处，且各自贴着自己引擎的请求对象取值（web-node 拿
// IncomingMessage，这里拿 FastifyRequest.raw）。第三个引擎出现时再谈归并（Rule of Three）。
//
// 返回 undefined = Host 头畸形或带凭据，调用方出 400：
//   `Host: a b`            → new URL 抛 TypeError
//   `Host: user@evil.com`  → new URL 通过，但 Fetch 规范要求带凭据的 URL 让 new Request 抛
// 参数收窄到结构上真正用到的两个字段（IncomingMessage 天然满足）：这样单测可以直接喂
// 字面量，不必为了造一个假的 IncomingMessage 写未经校验的断言。
export interface RequestTarget {
  readonly headers: { readonly host?: string };
  readonly url?: string;
}

// 校验与构造分家（#373）。原来是一件事：每请求 `new URL` 一次再赋 pathname/search，实测
// 502 纳秒，其中构造 URL 与两个 setter 占 335、Host 校验只占 167。而 fastify 的路由匹配走
// find-my-way 的字符串比较，根本不要 URL 对象——那 502 纳秒里绝大多数路由一分钱的用处都没有
// （端到端逐层压测是 0.79 微秒/请求，#373 顶楼的 L0→L1）。
//
// 拆开之后：校验仍然每请求做、仍然在进 handle 之前出 400（#226 的契约一字不动），URL 只在
// 真有人读 `context.url` 时才构造。
//
// 校验带一格缓存：真实服务上 Host 头在整个进程生命周期里基本恒定，同值重复时校验降到 2.4
// 纳秒。只留一格而不是 Map：键完全由请求方控制，Map 会被轮换的 Host 头撑成内存泄漏；轮换
// 也只是让缓存失效退回 167 纳秒，不比改之前差。
let cachedHost: string | undefined;
let cachedHostAccepted = false;

/**
 * Host 头是否可用作请求 URL 的 authority。返回 undefined = 畸形或带凭据，调用方出 400：
 *   `Host: a b`            → new URL 抛 TypeError
 *   `Host: user@evil.com`  → new URL 通过，但带凭据的 authority 一律不收
 */
export function acceptHost(raw: RequestTarget): string | undefined {
  const host = raw.headers.host ?? "localhost";
  if (host !== cachedHost) {
    cachedHost = host;
    cachedHostAccepted = false;
    try {
      const probe = new URL(`http://${host}`);
      cachedHostAccepted = probe.username === "" && probe.password === "";
    } catch {
      cachedHostAccepted = false;
    }
  }
  return cachedHostAccepted ? host : undefined;
}

/** 用已经通过校验的 host 构造本次请求的 URL。host 未经校验时不要调它。 */
export function targetUrl(host: string, target: string): URL {
  const url = new URL(`http://${host}`);
  const query = target.indexOf("?");
  url.pathname = query === -1 ? target : target.slice(0, query);
  url.search = query === -1 ? "" : target.slice(query);
  return url;
}

export function requestUrl(raw: RequestTarget): URL | undefined {
  const host = acceptHost(raw);
  return host === undefined ? undefined : targetUrl(host, raw.url ?? "/");
}

function toHeaders(raw: IncomingMessage): Headers {
  const headers = new Headers();
  // headersDistinct 保留同名多值；raw.headers 会把它们并成逗号串
  for (const [name, values] of Object.entries(raw.headersDistinct)) {
    for (const value of values ?? []) {
      headers.append(name, value);
    }
  }
  return headers;
}

// 每请求入口对象（#341）。此前 handler 无条件走 toRequest：headersDistinct 全量展开 + 逐条
// `headers.append()`（每条过一遍 WebIDL 的 ByteString 校验）+ `new Request`，实测约 1.5µs，
// 而 `GET /health` 一个请求头都不读——这份工作的产出被整个丢弃。
//
// 写成类（原型方法）而不是带闭包的对象字面量：后者每请求 3 次分配（对象 + 2 个闭包），
// 前者 1 次，且调用点保持单态。
export class FastifyIncomingRequest implements IncomingRequest {
  readonly method: string;
  private standardRequest: Request | undefined;

  private target: URL | undefined;

  constructor(
    private readonly raw: IncomingMessage,
    // 已通过 acceptHost 校验的 Host（#373）：URL 只在真有人读时才用它构造。
    private readonly host: string,
    // fastify 的 buffer parser 已经把体读完（见 engine.ts 的 addContentTypeParser）。
    private readonly body: unknown,
  ) {
    this.method = raw.method ?? "GET";
  }

  // fastify 的路由匹配不需要 URL 对象，所以引擎侧也不再急着造（#373）：`GET /json` 这类
  // 不读 context.url / context.query 的路由一次都不构造。
  url(): URL {
    this.target ??= targetUrl(this.host, this.raw.url ?? "/");
    return this.target;
  }

  // node 把头名小写化后存进 `headers`，所以按小写名一次哈希查找就到。toLowerCase 对本来就是
  // 全小写的 ASCII 串走 V8 的快路径、返回原串不分配；先试原名再回退小写反而更慢——头**不存在**
  // 时（`x-request-id` 的常态）两次查找都要做。
  //
  // 数组只在 set-cookie 与少数几个头上出现，按 HTTP 语义并成逗号串；框架自己不从请求侧读
  // set-cookie（IncomingRequest.header 的契约已写明这一例外）。
  header(name: string): string | null {
    const value = this.raw.headers[name.toLowerCase()];
    if (value === undefined) {
      return null;
    }
    return typeof value === "string" ? value : value.join(", ");
  }

  standard(): Request {
    // 必须缓存：同一请求内两次读 context.request 若拿到两个 Request，body 会被重复消费。
    this.standardRequest ??= toRequest(this.raw, this.url(), this.body);
    return this.standardRequest;
  }
}

// 从 fastify 已经读完的字节重建标准 Request。
//
// body 传的是 Buffer（BufferSource）而不是流：undici 对 BufferSource 既不推导也不覆写
// content-type，于是从 raw.headers 逐条 append 进去的原始头**原样存活**——multipart 的
// boundary 因此保得住，标准 Request.formData() 才解得开。实测：
//   ctSeenByStandardRequest: "multipart/form-data; boundary=----formdata-undici-0366..."
function toRequest(raw: IncomingMessage, url: URL, body: unknown): Request {
  const init: RequestInit = { method: raw.method ?? "GET", headers: toHeaders(raw) };
  if (init.method !== "GET" && init.method !== "HEAD" && Buffer.isBuffer(body)) {
    init.body = body;
  }
  return new Request(url, init);
}
