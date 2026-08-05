import type { PreparedRoute } from "@reforce/web/adapter";

// node:http 没有 Bun.serve 的原生 routes 表，路由分发整体由本模块承担（ADR 0006 契约不变，
// #207）：启动时把 PreparedRoute[] 编成 path-pattern 表，热路径 = 形状匹配 → 提参数 →
// route.handle。静态段精确命中优先于参数段命中（对齐 Bun routes 的特异性规则）；形状命中
// 但方法不符 → 405 + Allow（排序聚合所有重叠 pattern 的方法）；无命中 → 404。

interface PathPattern {
  readonly key: string;
  readonly segments: readonly string[];
  readonly handlers: Map<string, PreparedRoute>;
}

export type Dispatch =
  | {
      readonly kind: "match";
      readonly route: PreparedRoute;
      readonly params: Readonly<Record<string, string>>;
    }
  | { readonly kind: "method-mismatch"; readonly allowed: readonly string[] }
  | { readonly kind: "miss" };

function splitPath(path: string): readonly string[] {
  return path.split("/").filter((segment) => segment !== "");
}

interface ShapeMatch {
  readonly exact: boolean;
  readonly params: Record<string, string>;
}

function matchShape(
  pattern: readonly string[],
  segments: readonly string[],
): ShapeMatch | undefined {
  if (pattern.length !== segments.length) {
    return undefined;
  }
  let exact = true;
  const params: Record<string, string> = {};
  for (const [index, expected] of pattern.entries()) {
    const actual = segments[index];
    if (actual === undefined) {
      return undefined;
    }
    if (expected.startsWith(":")) {
      exact = false;
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return undefined;
    }
  }
  return { exact, params };
}

function compilePatterns(routes: readonly PreparedRoute[]): readonly PathPattern[] {
  const patterns: PathPattern[] = [];
  for (const route of routes) {
    const existing = patterns.find((pattern) => pattern.key === route.path);
    if (existing === undefined) {
      patterns.push({
        key: route.path,
        segments: splitPath(route.path),
        handlers: new Map([[route.method, route]]),
      });
    } else {
      existing.handlers.set(route.method, route);
    }
  }
  return patterns;
}

function scanPatterns(
  patterns: readonly PathPattern[],
  method: string,
  segments: readonly string[],
): Dispatch {
  const allowed = new Set<string>();
  let paramMatch:
    | { readonly route: PreparedRoute; readonly params: Record<string, string> }
    | undefined;
  for (const pattern of patterns) {
    const shape = matchShape(pattern.segments, segments);
    if (shape === undefined) {
      continue;
    }
    for (const allowedMethod of pattern.handlers.keys()) {
      allowed.add(allowedMethod);
    }
    const route = pattern.handlers.get(method);
    if (route === undefined) {
      continue;
    }
    if (shape.exact) {
      return { kind: "match", route, params: shape.params };
    }
    paramMatch ??= { route, params: shape.params };
  }
  if (paramMatch !== undefined) {
    return { kind: "match", route: paramMatch.route, params: paramMatch.params };
  }
  if (allowed.size > 0) {
    return { kind: "method-mismatch", allowed: [...allowed].toSorted() };
  }
  return { kind: "miss" };
}

export function createRouter(
  routes: readonly PreparedRoute[],
): (method: string, pathname: string) => Dispatch {
  const patterns = compilePatterns(routes);
  return (method, pathname) => scanPatterns(patterns, method, splitPath(pathname));
}
