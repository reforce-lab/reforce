import { describe, expect, test } from "vitest";
import { RequestContextState } from "@/execution/request-context";
import { defineRouteMarker } from "@/routing/route-marker";

function stateOf(inputs: {
  readonly url?: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly meta?: Readonly<Record<string, string>>;
}): RequestContextState {
  const url = inputs.url ?? "https://reforce.test/users/1";
  return new RequestContextState({
    request: new Request(url),
    url: new URL(url),
    method: "GET",
    path: "/users/:id",
    params: inputs.params ?? {},
    meta: inputs.meta ?? {},
  });
}

describe("RequestContextState inputs", () => {
  test("params start as the raw match record and are replaced by the validated value", () => {
    const context = stateOf({ params: { id: "42" } });

    expect(context.params).toEqual({ id: "42" });
    context.applyValidated("params", { id: 42n });
    expect(context.params).toEqual({ id: 42n });
  });

  test("query starts as a search-param snapshot and is replaced by the validated value", () => {
    const context = stateOf({ url: "https://reforce.test/users?limit=10&offset=0" });

    expect(context.query).toEqual({ limit: "10", offset: "0" });
    context.applyValidated("query", { limit: 10 });
    expect(context.query).toEqual({ limit: 10 });
  });

  test("body stays undefined until a validated value is applied", () => {
    const context = stateOf({});

    expect(context.body).toBeUndefined();
    context.applyValidated("body", { name: "amy" });
    expect(context.body).toEqual({ name: "amy" });
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
  test("exposes one mutable Headers instance shared across reads", () => {
    const context = stateOf({});

    context.responseHeaders.set("x-request-id", "abc");

    expect(context.responseHeaders.get("x-request-id")).toBe("abc");
    expect(context.responseHeaders).toBeInstanceOf(Headers);
  });

  test("starts empty for every new request context", () => {
    const context = stateOf({});

    expect([...context.responseHeaders.keys()]).toEqual([]);
  });
});
