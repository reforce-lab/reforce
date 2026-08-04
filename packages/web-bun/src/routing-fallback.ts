import type { PreparedRoute } from "@reforce/web";

// 未命中 Bun 原生 routes 的请求（冷路径）：路径形状能匹配某条路由但方法不符 → 405 + Allow；
// 否则 404。Bun 对方法不匹配与未注册 HEAD 都直接落 fetch fallback（spike 实测），404/405
// 的区分只能在这里做；这条路径每请求都要重新匹配，但它只服务错误请求，不在性能故事里。

interface PathPattern {
  readonly segments: readonly string[];
  readonly methods: Set<string>;
}

function splitPath(path: string): readonly string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function matchesPattern(pattern: readonly string[], segments: readonly string[]): boolean {
  if (pattern.length !== segments.length) {
    return false;
  }
  return pattern.every(
    (expected, index) => expected.startsWith(":") || expected === segments[index],
  );
}

export function createFallbackResponder(
  routes: readonly PreparedRoute[],
): (request: Request) => Response {
  const patterns = new Map<string, PathPattern>();
  for (const route of routes) {
    const pattern = patterns.get(route.path);
    if (pattern === undefined) {
      patterns.set(route.path, {
        segments: splitPath(route.path),
        methods: new Set([route.method]),
      });
    } else {
      pattern.methods.add(route.method);
    }
  }
  const all = [...patterns.values()];
  return (request) => {
    const segments = splitPath(new URL(request.url).pathname);
    const allowed = new Set<string>();
    for (const pattern of all) {
      if (matchesPattern(pattern.segments, segments)) {
        for (const method of pattern.methods) {
          allowed.add(method);
        }
      }
    }
    if (allowed.size === 0) {
      return new Response(null, { status: 404 });
    }
    return new Response(null, {
      status: 405,
      headers: { allow: [...allowed].toSorted().join(", ") },
    });
  };
}
