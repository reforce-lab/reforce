import type { StandardSchemaV1 } from "@standard-schema/spec";
import { metaLookup, type RouteMarker } from "@/routing/route-marker";
import type { HttpMethod, RouteMetaValue, RouteSchemas } from "@/routing/vocabulary";

// 路由 schema 已经带着类型（ADR 0006 W5）：把它接到 handler 上，handler 里就不必再用
// `as` 把 unknown 断言回 schema 已经保证的形状。没声明该槽位的路由，Infer 落回 unknown
// ——那才是诚实的声明。
export type InferSchemaOutput<S> = S extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<S>
  : unknown;

// handler 契约面向 Web 标准（ADR 0006 W3）：request/url 就是标准 Request/URL，不发明自有
// 请求对象。类型参数缺省为 RouteSchemas（四个槽位全 optional），此时三个数据槽位都是
// unknown——RequestContextState、RouteMiddleware.handle 与 ErrorDispatcher 这些跨路由共用
// 的位置因此完全不变。
export interface RequestContext<S extends RouteSchemas = RouteSchemas> {
  readonly request: Request;
  readonly url: URL;
  readonly method: HttpMethod;
  // 路由模式（如 /users/:id），不是本次请求的具体路径；具体路径看 url.pathname。
  readonly path: string;
  // 校验阶段之前是路径匹配的原始字符串记录；声明了 params schema 时，校验后被
  // 校验+decode 产物替换（雪花 string→bigint 一类 codec 在这里生效）。
  readonly params: InferSchemaOutput<S["params"]>;
  // 声明了 query schema 时为校验产物；未声明时是 searchParams 的普通对象快照。
  readonly query: InferSchemaOutput<S["query"]>;
  // 只有声明了 body schema 才读取请求体；未声明时恒为 undefined。
  readonly body: InferSchemaOutput<S["body"]>;
  // 响应头出口(RFC 0012 S2,#274):handler 的 `Headers` 裸标注参数与中间件共用这一个原生
  // Headers 实例;core runner 在拿到最终响应后统一 merge——只合并编码/序列化产出的响应,
  // 不碰 handler 直接返回的 Response(逃生口)与错误响应。
  readonly responseHeaders: Headers;
  meta<T extends RouteMetaValue>(marker: RouteMarker<T>): T | undefined;
}

interface RequestContextInputs {
  readonly request: Request;
  readonly url: URL;
  readonly method: HttpMethod;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly meta: Readonly<Record<string, RouteMetaValue>>;
}

// 可变内核 + 只读视图：校验阶段（全部中间件之后、handler 之前）一次性写入校验产物，
// 其余消费方只经 RequestContext 读。
export class RequestContextState implements RequestContext {
  readonly request: Request;
  readonly url: URL;
  readonly method: HttpMethod;
  readonly path: string;
  // 显式标注:不标注时推导类型指向 undici-types 的 Headers,d.ts 生成报 TS2883 不可移植。
  readonly responseHeaders: Headers = new Headers();
  private readonly lookupMeta: ReturnType<typeof metaLookup>;
  private validatedParams: unknown;
  private queryValidated = false;
  private validatedQuery: unknown;
  private validatedBody: unknown;
  private capturedFailure: unknown;

  constructor(inputs: RequestContextInputs) {
    this.request = inputs.request;
    this.url = inputs.url;
    this.method = inputs.method;
    this.path = inputs.path;
    this.lookupMeta = metaLookup(inputs.meta);
    this.validatedParams = inputs.params;
  }

  get params(): unknown {
    return this.validatedParams;
  }

  get query(): unknown {
    return this.queryValidated ? this.validatedQuery : snapshotQuery(this.url);
  }

  get body(): unknown {
    return this.validatedBody;
  }

  meta<T extends RouteMetaValue>(marker: RouteMarker<T>): T | undefined {
    return this.lookupMeta(marker);
  }

  // 框架内部状态，不在公开的 RequestContext 上（同 applyValidated）。B2（#250）：handler 抛
  // 的错被 dispatchError 换成响应之后，请求日志只看得到 status，错误对象就此丢失。
  //
  // 先到先得：错误处理器可以 rethrow 换一个错（W4 的「换错即升级」），但值得记的是边界上
  // 最初真的发生了什么，后面那些是处理过程。
  recordFailure(error: unknown): void {
    this.capturedFailure ??= error;
  }

  get failure(): unknown {
    return this.capturedFailure;
  }

  applyValidated(source: "body" | "params" | "query", value: unknown): void {
    if (source === "params") {
      this.validatedParams = value;
      return;
    }
    if (source === "query") {
      this.queryValidated = true;
      this.validatedQuery = value;
      return;
    }
    this.validatedBody = value;
  }
}

function snapshotQuery(url: URL): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(url.searchParams));
}
