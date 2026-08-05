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
});
