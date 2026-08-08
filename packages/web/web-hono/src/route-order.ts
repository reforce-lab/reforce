import type { PreparedRoute } from "@reforce/web-core/adapter";

// hono 按**注册顺序**匹配，没有静态段优先的概念（#236）（实测：`/users/:id` 先注册就把 `/users/self`
// 和 `/users/me` 全吃掉，9 条探针错 5 条）。而编译器按 compareUtf16CodeUnits 排序发射
// （web-routes.ts），`:` 是 0x3A、小写字母从 0x61 起，所以 `/users/:id` **必然**排在
// `/users/self`、`/users/me` 之前。两件事凑到一起就是静默错路由：只写 `/users/:id` 的测试
// 全绿，等用户加一条 `/users/me` 才炸。
//
// 因此注册前必须按特异度重排。逐段比较，不能只看首段——`/users/:id/posts` 也排在
// `/users/me` 之前，首段（users）一样，差别在第二段。
//
// 排序只在公共前缀上分胜负，段数不同的两条路由匹配不到同一个请求（reforce 的路由没有通配
// 段），它们的先后无所谓；这种情况让 toSorted 的稳定性保住发射顺序，注册结果因此仍是确定的。

function isParameter(segment: string): boolean {
  return segment.startsWith(":");
}

// 静态段(0) 胜过参数段(1)，取最左侧的差异——与 radix 树的 leftmost-most-specific 语义一致。
export function compareRouteSpecificity(left: string, right: string): number {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  const shared = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < shared; index += 1) {
    const leftIsParameter = isParameter(leftSegments[index] ?? "");
    const rightIsParameter = isParameter(rightSegments[index] ?? "");
    if (leftIsParameter !== rightIsParameter) {
      return leftIsParameter ? 1 : -1;
    }
  }
  return 0;
}

export function orderRoutesForHono(routes: readonly PreparedRoute[]): readonly PreparedRoute[] {
  return routes.toSorted((left, right) => compareRouteSpecificity(left.path, right.path));
}
