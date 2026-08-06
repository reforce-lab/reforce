import type { PreparedRoute } from "@reforce/web/adapter";
import Router from "find-my-way";

// node:http 没有原生 routes 表，路由分发整体由本模块承担（ADR 0006 契约不变，#207）：启动时把
// PreparedRoute[] 注册进 find-my-way 的 radix 树，热路径 = find() → 拷参数 → route.handle。
// #211 之前这里是逐条 pattern 线性扫描的手写匹配器（O(路由总数)，且 Allow 集合在每个请求上聚合）。
// 静态段命中优先于参数段命中——这是本路由自己的既有契约（由 test/router.spec.ts 钉住），radix
// 树原生就是这个优先级，无需额外代码维持；形状命中但方法不符 → 405 + Allow；无命中 → 404。

export type Dispatch =
  | {
      readonly kind: "match";
      readonly route: PreparedRoute;
      readonly params: Readonly<Record<string, string>>;
    }
  | { readonly kind: "method-mismatch"; readonly allowed: readonly string[] }
  | { readonly kind: "miss" };

type HttpMethod = PreparedRoute["method"];

// find-my-way 的 store 参数类型是 any，直接读回来就得靠未经校验的断言。改用注册时的 handler 做
// 身份键：find() 返回的 handler 就是 on() 传入的那个函数引用（=== 成立），于是这张边表能以完整
// 类型取回 PreparedRoute。键类型写 object 而不是具体函数签名，是为了不去触碰 find-my-way 的
// Handler 类型——它挂在 `export =` 的命名空间下，默认导入拿不到类型面。
type MarkerTable = WeakMap<object, PreparedRoute>;

interface Registry {
  readonly router: ReturnType<typeof Router>;
  readonly byMarker: MarkerTable;
  // key 与 value 同为方法字符串：Set.has() 不会把 string 窄化成 HttpMethod，Map.get() 会。
  // 只收本应用实际注册过的方法，未注册的方法字符串（TRACE、FOO、大小写不符）直接落到探测分支。
  readonly methods: ReadonlyMap<string, HttpMethod>;
}

function register(routes: readonly PreparedRoute[], maxParamLength: number): Registry {
  const router = Router({
    // 手写匹配器的 splitPath 过滤空段，/users、/users/、//users、/users//42 今天全部等价；
    // find-my-way 这两个选项默认关闭，不显式打开就是静默的行为回归（#211）。
    ignoreTrailingSlash: true,
    ignoreDuplicateSlashes: true,
    maxParamLength,
  });
  const byMarker: MarkerTable = new WeakMap();
  const methods = new Map<string, HttpMethod>();
  for (const route of routes) {
    const marker = () => {};
    byMarker.set(marker, route);
    router.on(route.method, route.path, marker);
    methods.set(route.method, route.method);
  }
  return { router, byMarker, methods };
}

function toParams(found: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(found)) {
    // noUncheckedIndexedAccess 下 find-my-way 的 params 值类型带 undefined；未捕获的参数不入表
    if (value !== undefined) {
      params[name] = value;
    }
  }
  return params;
}

// find-my-way 没有内建的 405/Allow，hasRoute/findRoute 又是按注册模式精确查（hasRoute("GET",
// "/users/self") 对已注册的 /users/:id 返回 false），只有 find() 能回答"这个路径在别的方法下
// 能不能命中"。逐个方法探测只发生在 find() 已经落空的错误路径上，正常命中的请求不付这份成本。
function probeAllowed(registry: Registry, pathname: string): readonly string[] {
  const allowed: HttpMethod[] = [];
  for (const candidate of registry.methods.values()) {
    if (registry.router.find(candidate, pathname) !== null) {
      allowed.push(candidate);
    }
  }
  return allowed.toSorted();
}

export function createRouter(
  routes: readonly PreparedRoute[],
  maxParamLength?: number,
): (method: string, pathname: string) => Dispatch {
  // 缺省不限制参数长度，与手写匹配器时代一致：find-my-way 自己的默认值是 100，不显式传就会把
  // 长参数请求静默变成 404（#211）。
  const registry = register(routes, maxParamLength ?? Number.MAX_SAFE_INTEGER);
  return (method, pathname) => {
    const known = registry.methods.get(method);
    // 坏转义（/users/%ZZ）等非法路径在 find() 里就是 null，不会像 decodeURIComponent 那样抛
    // URIError——那个异常会经 engine.ts 的 void serve(...) 变成 unhandled rejection 挂住响应（#211）。
    const found = known === undefined ? null : registry.router.find(known, pathname);
    if (found !== null) {
      const route = registry.byMarker.get(found.handler);
      if (route !== undefined) {
        return { kind: "match", route, params: toParams(found.params) };
      }
    }
    const allowed = probeAllowed(registry, pathname);
    if (allowed.length > 0) {
      return { kind: "method-mismatch", allowed };
    }
    return { kind: "miss" };
  };
}
