import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { RouteMarker } from "@/routing/route-marker";
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
  private readonly metaByKey: Readonly<Record<string, RouteMetaValue>>;
  private validatedParams: unknown;
  private queryValidated = false;
  private validatedQuery: unknown;
  private validatedBody: unknown;

  constructor(inputs: RequestContextInputs) {
    this.request = inputs.request;
    this.url = inputs.url;
    this.method = inputs.method;
    this.path = inputs.path;
    this.metaByKey = inputs.meta;
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
    // 表里的值由编译器从 @Marker(value: T) 的字面量参数提取而来，T 在声明处即被钉死，
    // 运行时序列化形态推不回字面量类型 // justified: 见上一行
    return this.metaByKey[marker.key] as T | undefined;
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
