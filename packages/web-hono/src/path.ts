// WebEngineAdapter 契约要求 `/p` ≡ `/p/` ≡ `//p`，坏转义按未命中处理（#236）。hono 两条都不做
// （实测：`/health/` 与 `//health` 都是 404，`/users/%ZZ` 反而 200 且 id 是字面量 "%ZZ"），
// 所以两件事都在自定义 getPath 里补。
//
// **绝对不要传 `strict: false`**：hono-base 的赋值逻辑会让自定义 getPath 的调用次数归零，
// 且无任何警告（实测 1 → 0）；它自带的 getPathNoStrict 也只剥一个尾斜杠，`//p` 完全不归一。
//
// 解码走 decodeURI 而不是 decodeURIComponent，与 web-node 的既有契约对齐：`%2F` 在路径层
// 保留（`/users/a%2Fb` → 参数 `a/b`，段结构不被拆开），`%20` 正常解开。hono 自己再对参数做
// 一次 decodeURIComponent，两级合起来的结果与 find-my-way 一致（实测两侧都是 `a/b` / `a b`）。

// 路由 path 由编译器的 literalSegmentPattern 校验过，不含 NUL，所以这个哨兵永远匹配不上任何
// 已注册路由——坏转义因此落进 hono 自己的 404，而不是抛异常逃出请求循环。
export const unmatchablePath = "/\u0000reforce-malformed-escape";

function normalizeSlashes(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/")) {
    return collapsed.slice(0, -1);
  }
  return collapsed;
}

export function honoRequestPath(request: Request): string {
  const url = request.url;
  // "http://" / "https://" 之后的第一个 "/" 就是路径起点（hono 自己的 getPath 同样从 8 起找）
  const start = url.indexOf("/", 8);
  if (start === -1) {
    return "/";
  }
  const query = url.indexOf("?", start);
  const raw = url.slice(start, query === -1 ? undefined : query);
  try {
    return normalizeSlashes(decodeURI(raw));
  } catch {
    // 非法 percent-escape（%ZZ、截断的 %E0%A4%A）：按未命中处理
    return unmatchablePath;
  }
}
