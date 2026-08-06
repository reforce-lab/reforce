import type { PreparedRoute } from "@reforce/web/adapter";
import { describe, expect, test } from "vitest";
import { createRouter, type Dispatch } from "@/router";

function route(method: PreparedRoute["method"], path: string): PreparedRoute {
  return {
    method,
    path,
    handle: () => Promise.resolve(new Response("unreachable")),
  };
}

function dispatch(routes: readonly PreparedRoute[], method: string, path: string): Dispatch {
  return createRouter(routes)(method, path);
}

describe("createRouter", () => {
  test("a static route matches with empty params", () => {
    const outcome = dispatch([route("GET", "/users")], "GET", "/users");

    expect(outcome.kind).toBe("match");
    if (outcome.kind !== "match") {
      return;
    }
    expect(outcome.route.method).toBe("GET");
    expect(outcome.params).toEqual({});
  });

  test("a parameterized route extracts and decodes the path params", () => {
    const outcome = dispatch([route("GET", "/users/:id")], "GET", "/users/a%2Fb");

    expect(outcome.kind).toBe("match");
    if (outcome.kind !== "match") {
      return;
    }
    expect(outcome.params).toEqual({ id: "a/b" });
  });

  test("a static pattern wins over an overlapping parameterized one", () => {
    const outcome = dispatch(
      [route("GET", "/users/:id"), route("PUT", "/users/self")],
      "PUT",
      "/users/self",
    );

    expect(outcome.kind).toBe("match");
    if (outcome.kind !== "match") {
      return;
    }
    expect(outcome.route.method).toBe("PUT");
    expect(outcome.params).toEqual({});
  });

  test("an unknown path is a miss", () => {
    expect(dispatch([route("GET", "/users")], "GET", "/nope")).toEqual({ kind: "miss" });
  });

  test("a method mismatch on a known static path aggregates the sorted Allow set", () => {
    const outcome = dispatch([route("POST", "/users"), route("GET", "/users")], "DELETE", "/users");

    expect(outcome).toEqual({ kind: "method-mismatch", allowed: ["GET", "POST"] });
  });

  test("a method mismatch on a parameterized path matches by segment shape", () => {
    const outcome = dispatch([route("GET", "/users/:id")], "POST", "/users/42");

    expect(outcome).toEqual({ kind: "method-mismatch", allowed: ["GET"] });
  });

  test("a parameterized pattern does not match a path with extra segments", () => {
    expect(dispatch([route("GET", "/users/:id")], "GET", "/users/42/posts")).toEqual({
      kind: "miss",
    });
  });

  test("overlapping patterns aggregate every allowed method", () => {
    const outcome = dispatch(
      [route("GET", "/users/:id"), route("PUT", "/users/self")],
      "DELETE",
      "/users/self",
    );

    expect(outcome).toEqual({ kind: "method-mismatch", allowed: ["GET", "PUT"] });
  });

  // 坏转义（#211）：`new URL()` 把 `%ZZ` 原样留在 pathname 里，分派必须把它当未命中，
  // 而不是让 decodeURIComponent 的 URIError 逃出去——它会在引擎里变成 unhandled
  // rejection，响应永不写出。
  test("a malformed percent-escape in the path is a miss, not a throw", () => {
    expect(dispatch([route("GET", "/users/:id")], "GET", "/users/%ZZ")).toEqual({ kind: "miss" });
  });

  test.each([
    ["a trailing slash", "/users/42/"],
    ["a leading duplicate slash", "//users/42"],
    ["an inner duplicate slash", "/users//42"],
  ])("%s is equivalent to the canonical path", (_case, path) => {
    const outcome = dispatch([route("GET", "/users/:id")], "GET", path);

    expect(outcome.kind).toBe("match");
    if (outcome.kind !== "match") {
      return;
    }
    expect(outcome.params).toEqual({ id: "42" });
  });

  // find-my-way 自带 maxParamLength: 100，缺省不显式关掉就会把长参数请求静默变成 404（#211）
  test("a path param longer than the upstream default cap still matches", () => {
    const id = "x".repeat(150);

    const outcome = dispatch([route("GET", "/users/:id")], "GET", `/users/${id}`);

    expect(outcome.kind).toBe("match");
    if (outcome.kind !== "match") {
      return;
    }
    expect(outcome.params).toEqual({ id });
  });

  test("an over-length path param is a miss once maxParamLength is set", () => {
    const outcome = createRouter([route("GET", "/users/:id")], 8)("GET", "/users/123456789");

    expect(outcome).toEqual({ kind: "miss" });
  });
});
