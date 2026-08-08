import type { IncomingRequest } from "@/execution/incoming-request";
import { metaLookup, type RouteMarker } from "@/routing/route-marker";
import type { HttpMethod, RouteMetaValue } from "@/routing/vocabulary";

// handler 契约面向 Web 标准（ADR 0006 W3）：request/url 就是标准 Request/URL，不发明自有
// 请求对象。校验+decode 产物不再走这里(RFC 0012 S2,#274):槽位解码结果按参数序经
// route.invoke 第三参直达 handler 形参,context 上的 params/query 恒为原始快照——中间件与
// 错误处理器看到的是请求的本来面目,不随某条路由的契约变形。
export interface RequestContext {
  readonly request: Request;
  readonly url: URL;
  readonly method: HttpMethod;
  // 路由模式（如 /users/:id），不是本次请求的具体路径；具体路径看 url.pathname。
  readonly path: string;
  /** 路径匹配的原始字符串记录。 */
  readonly params: Readonly<Record<string, string>>;
  /** searchParams 的普通对象快照;同名参数后值覆盖。 */
  readonly query: Readonly<Record<string, string>>;
  // 响应头出口(RFC 0012 S2,#274):handler 的 `Headers` 裸标注参数与中间件共用这一个原生
  // Headers 实例;core runner 在拿到最终响应后统一 merge——只合并编码产出的响应,
  // 不碰 handler 直接返回的 Response(逃生口)与错误响应。
  readonly responseHeaders: Headers;
  meta<T extends RouteMetaValue>(marker: RouteMarker<T>): T | undefined;
}

interface RequestContextInputs {
  readonly incoming: IncomingRequest;
  readonly method: HttpMethod;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly meta: Readonly<Record<string, RouteMetaValue>>;
}

export class RequestContextState implements RequestContext {
  readonly method: HttpMethod;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  // 显式标注:不标注时推导类型指向 undici-types 的 Headers,d.ts 生成报 TS2883 不可移植。
  readonly responseHeaders: Headers = new Headers();
  private readonly incoming: IncomingRequest;
  private readonly lookupMeta: ReturnType<typeof metaLookup>;
  private urlSnapshot: URL | undefined;
  private querySnapshot: Readonly<Record<string, string>> | undefined;
  private capturedFailure: unknown;

  constructor(inputs: RequestContextInputs) {
    this.incoming = inputs.incoming;
    this.method = inputs.method;
    this.path = inputs.path;
    this.params = inputs.params;
    this.lookupMeta = metaLookup(inputs.meta);
  }

  // 惰性（#341）：标准 Request 只在真有人读时才造，缓存归 IncomingRequest 的实现——同一请求
  // 内必须是同一个实例，否则 body 会被重复消费。
  get request(): Request {
    return this.incoming.standard();
  }

  // URL 解析此前发生两次：引擎为了路由匹配解析一次，核心再 `new URL(request.url)` 解析同一个
  // 字符串一次。现在引擎把它已经解析好的那一个直接交出来（#341），第二次彻底消失；引擎没有
  // 现成 URL 时由它自己按需解析并缓存，`/health` 这类没人读 url 的路由一次都不解析。
  get url(): URL {
    this.urlSnapshot ??= this.incoming.url();
    return this.urlSnapshot;
  }

  get query(): Readonly<Record<string, string>> {
    this.querySnapshot ??= Object.freeze(Object.fromEntries(this.url.searchParams));
    return this.querySnapshot;
  }

  meta<T extends RouteMetaValue>(marker: RouteMarker<T>): T | undefined {
    return this.lookupMeta(marker);
  }

  // 框架内部状态，不在公开的 RequestContext 上。B2（#250）：handler 抛的错被 dispatchError
  // 换成响应之后，请求日志只看得到 status，错误对象就此丢失。
  //
  // 先到先得：错误处理器可以 rethrow 换一个错（W4 的「换错即升级」），但值得记的是边界上
  // 最初真的发生了什么，后面那些是处理过程。
  recordFailure(error: unknown): void {
    this.capturedFailure ??= error;
  }

  get failure(): unknown {
    return this.capturedFailure;
  }
}
