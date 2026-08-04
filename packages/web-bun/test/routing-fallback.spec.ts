import { describe, expect, test } from "bun:test";
import type { PreparedRoute } from "@reforce/web/adapter";
import { createFallbackResponder } from "@/routing-fallback";

function route(method: PreparedRoute["method"], path: string): PreparedRoute {
  return {
    method,
    path,
    handle: () => Promise.resolve(new Response("unreachable")),
  };
}

function respond(routes: readonly PreparedRoute[], method: string, path: string): Response {
  const responder = createFallbackResponder(routes);
  return responder(new Request(`https://reforce.test${path}`, { method }));
}

describe("createFallbackResponder", () => {
  test("an unknown path yields 404 with an empty body", async () => {
    const response = respond([route("GET", "/users")], "GET", "/nope");

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers.get("allow")).toBeNull();
  });

  test("a method mismatch on a known static path yields 405 with sorted Allow", () => {
    const response = respond([route("POST", "/users"), route("GET", "/users")], "DELETE", "/users");

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
  });

  test("a method mismatch on a parameterized path matches by segment shape", () => {
    const response = respond([route("GET", "/users/:id")], "POST", "/users/42");

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  test("a parameterized pattern does not match a path with extra segments", () => {
    const response = respond([route("GET", "/users/:id")], "GET", "/users/42/posts");

    expect(response.status).toBe(404);
  });

  test("overlapping patterns aggregate every allowed method", () => {
    const response = respond(
      [route("GET", "/users/:id"), route("PUT", "/users/self")],
      "DELETE",
      "/users/self",
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, PUT");
  });
});
