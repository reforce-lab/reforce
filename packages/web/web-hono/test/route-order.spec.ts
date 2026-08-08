import { absorbResponse } from "@reforce/web-core";
import type { PreparedRoute } from "@reforce/web-core/adapter";
import { describe, expect, test } from "vitest";
import { compareRouteSpecificity, orderRoutesForHono } from "@/route-order";

// hono 按注册顺序匹配、没有静态段优先的概念，而编译器按 compareUtf16CodeUnits 排序发射
// （`:` 0x3A < 小写字母 0x61），于是参数路由必然排在同前缀的静态路由之前。这是本包唯一
// 必须自己扛的路由语义，也是最容易假绿的一条：只写 /users/:id 的测试全绿，等用户加一条
// /users/me 才炸。

function route(path: string): PreparedRoute {
  return {
    method: "GET",
    path,
    handle: () => Promise.resolve(absorbResponse(new Response("unreachable"), new Headers())),
    meta: () => undefined,
  };
}

// 编译器的发射顺序：按 path 的 UTF-16 码元升序
function asEmitted(paths: readonly string[]): readonly PreparedRoute[] {
  return paths.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)).map(route);
}

describe("orderRoutesForHono", () => {
  test("a static segment is registered ahead of an overlapping parameter segment", () => {
    const ordered = orderRoutesForHono(asEmitted(["/users/:id", "/users/self"]));

    expect(ordered.map((item) => item.path)).toEqual(["/users/self", "/users/:id"]);
  });

  // 只看首段不够：/users/:id/posts 与 /users/me 的首段都是 users，差别在第二段
  test("specificity is compared segment by segment, not just on the first one", () => {
    const ordered = orderRoutesForHono(asEmitted(["/users/:id/posts", "/users/me"]));

    expect(ordered.map((item) => item.path)).toEqual(["/users/me", "/users/:id/posts"]);
  });

  test("a deeper static segment still wins after a shared parameter prefix", () => {
    const ordered = orderRoutesForHono(asEmitted(["/a/:b/:c", "/a/:b/c"]));

    expect(ordered.map((item) => item.path)).toEqual(["/a/:b/c", "/a/:b/:c"]);
  });

  // 段数不同的两条路由匹配不到同一个请求，先后无所谓；稳定排序让发射顺序原样保留，
  // 注册结果因此仍是确定的（两次编译逐字节一致的前提）。
  test("routes that cannot collide keep their emitted order", () => {
    const ordered = orderRoutesForHono(asEmitted(["/b", "/a", "/c"]));

    expect(ordered.map((item) => item.path)).toEqual(["/a", "/b", "/c"]);
  });

  test("the full emitted table lands with every static route ahead of its parameter rival", () => {
    const ordered = orderRoutesForHono(
      asEmitted([
        "/health",
        "/users/:id",
        "/users/:id/posts",
        "/users/me",
        "/users/self",
        "/users/self/posts",
      ]),
    );

    expect(ordered.map((item) => item.path)).toEqual([
      "/health",
      "/users/me",
      "/users/self",
      "/users/self/posts",
      "/users/:id",
      "/users/:id/posts",
    ]);
  });
});

describe("compareRouteSpecificity", () => {
  test("two paths with the same segment kinds compare equal", () => {
    expect(compareRouteSpecificity("/a/:b", "/x/:y")).toBe(0);
  });

  test("the leftmost difference decides", () => {
    // 第一段就分出胜负，后面的段不再参与——与 radix 树的 leftmost-most-specific 语义一致
    expect(compareRouteSpecificity("/a/:b", "/:a/b")).toBeLessThan(0);
  });
});
