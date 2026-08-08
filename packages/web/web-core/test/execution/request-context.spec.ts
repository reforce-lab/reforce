import { describe, expect, test } from "vitest";
import { fromStandardRequest } from "@/execution/incoming-request";
import { RequestContextState } from "@/execution/request-context";
import { defineRouteMarker } from "@/routing/route-marker";

function stateOf(inputs: {
  readonly url?: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly meta?: Readonly<Record<string, string>>;
}): RequestContextState {
  const url = inputs.url ?? "https://reforce.test/users/1";
  return new RequestContextState({
    incoming: fromStandardRequest(new Request(url)),
    method: "GET",
    path: "/users/:id",
    params: inputs.params ?? {},
    meta: inputs.meta ?? {},
  });
}

// 校验产物不再写回 context(RFC 0012 S2,#274):槽位解码结果经 invoke 第三参直达 handler,
// context 上的 params/query 恒为原始快照。
describe("RequestContextState inputs", () => {
  test("params expose the raw match record", () => {
    const context = stateOf({ params: { id: "42" } });

    expect(context.params).toEqual({ id: "42" });
  });

  test("query exposes a search-param snapshot with later duplicates winning", () => {
    const context = stateOf({ url: "https://reforce.test/users?limit=10&offset=0&limit=20" });

    expect(context.query).toEqual({ limit: "20", offset: "0" });
  });

  test("the query snapshot is frozen and stable across reads", () => {
    const context = stateOf({ url: "https://reforce.test/users?limit=10" });

    expect(context.query).toBe(context.query);
    expect(Object.isFrozen(context.query)).toBe(true);
  });
});

describe("RequestContextState route meta", () => {
  test("meta reads a marker value by its key", () => {
    const Roles = defineRouteMarker<string>("roles");
    const context = stateOf({ meta: { roles: "admin" } });

    expect(context.meta(Roles)).toBe("admin");
  });

  test("meta returns undefined for an absent marker", () => {
    const Missing = defineRouteMarker<string>("missing");
    const context = stateOf({});

    expect(context.meta(Missing)).toBeUndefined();
  });
});

// —— 响应头出口(RFC 0012 S2,#274) ——

describe("RequestContextState response headers", () => {
  test("exposes one mutable carrier shared across reads", () => {
    const context = stateOf({});

    context.responseHeaders.set("x-request-id", "abc");

    expect(context.responseHeaders.get("x-request-id")).toBe("abc");
  });

  test("starts empty for every new request context", () => {
    const context = stateOf({});

    expect([...context.responseHeaders.standard().keys()]).toEqual([]);
  });

  // RFC 0012 S2 的「handler 的 Headers 参数与中间件共用同一个实例」在 #373 之后仍然成立：
  // 物化之后载体把每个方法都转发给那一个 Headers，任一时刻只有一个真相。
  test("keeps one truth after materializing: later writes land in the same Headers", () => {
    const context = stateOf({});
    const standard = context.responseHeaders.standard();

    context.responseHeaders.set("x-request-id", "abc");

    expect(standard.get("x-request-id")).toBe("abc");
    expect(context.responseHeaders.standard()).toBe(standard);
  });
});
