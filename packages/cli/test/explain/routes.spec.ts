import { describe, expect, test } from "vitest";
import {
  isRouteQuery,
  matchRoutes,
  parseRouteManifestBytes,
  parseRouteQuery,
  type RouteManifest,
  renderRouteExplanation,
  renderRouteOverview,
} from "@/explain/routes";

const manifest: RouteManifest = {
  routes: [
    {
      method: "GET",
      path: "/users/:id",
      controller: { beanId: "src/users.ts#UsersController", handler: "show" },
      middleware: [
        { beanId: "src/trace.ts#Trace", phase: "observability", order: 0, mount: "global" },
        { beanId: "src/guard.ts#Guard", phase: "admission", order: 0, mount: "global" },
      ],
      meta: { roles: ["admin"] },
      schemas: { params: {}, response: {} },
    },
    {
      method: "POST",
      path: "/users",
      controller: { beanId: "src/users.ts#UsersController", handler: "create" },
      middleware: [],
      meta: {},
      schemas: {},
    },
  ],
  errorHandlers: [{ beanId: "src/errors.ts#Teapot", order: 0 }],
};

function encoded(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe("parseRouteQuery", () => {
  test("a bare path targets every method", () => {
    expect(parseRouteQuery("/users/:id")).toEqual({ path: "/users/:id" });
  });

  test("a method prefix narrows and is case-normalized", () => {
    expect(parseRouteQuery("get /users/42")).toEqual({ method: "GET", path: "/users/42" });
  });

  test("bean-shaped queries are not route queries", () => {
    expect(isRouteQuery("src/users.ts#UsersController")).toBe(false);
    expect(isRouteQuery("Cache")).toBe(false);
    expect(parseRouteQuery("GET users")).toBeUndefined();
  });
});

describe("parseRouteManifestBytes", () => {
  test("a valid manifest round-trips", () => {
    const parsed = parseRouteManifestBytes(encoded({ schemaVersion: 1, ...manifest }));

    expect(parsed?.routes).toHaveLength(2);
    expect(parsed?.errorHandlers).toEqual([{ beanId: "src/errors.ts#Teapot", order: 0 }]);
  });

  test("a wrong schema version is rejected", () => {
    expect(
      parseRouteManifestBytes(encoded({ schemaVersion: 2, routes: [], errorHandlers: [] })),
    ).toBeUndefined();
  });

  test("a malformed route entry is rejected", () => {
    const bytes = encoded({
      schemaVersion: 1,
      routes: [{ method: "GET" }],
      errorHandlers: [],
    });

    expect(parseRouteManifestBytes(bytes)).toBeUndefined();
  });
});

describe("matchRoutes", () => {
  test("the pattern itself matches", () => {
    expect(matchRoutes(manifest, { path: "/users/:id" })).toHaveLength(1);
  });

  test("a concrete path matches the pattern by segments", () => {
    const matches = matchRoutes(manifest, { path: "/users/42" });

    expect(matches.map((route) => route.method)).toEqual(["GET"]);
  });

  test("a method filter narrows overlapping paths", () => {
    expect(matchRoutes(manifest, { method: "POST", path: "/users" })).toHaveLength(1);
    expect(matchRoutes(manifest, { method: "DELETE", path: "/users" })).toHaveLength(0);
  });
});

describe("renderRouteExplanation", () => {
  test("a route renders handler, flattened chain, schemas, meta, and error handlers", () => {
    const lines = renderRouteExplanation(manifest, matchRoutes(manifest, { path: "/users/42" }));

    expect(lines).toEqual([
      "GET /users/:id",
      "  handler src/users.ts#UsersController · show()",
      "  middleware chain (outer → inner) · flattened at compile time by (phase, order, beanId)",
      "  1. observability · order 0 · global · src/trace.ts#Trace",
      "  2. admission · order 0 · global · src/guard.ts#Guard",
      "  schemas · params, response",
      '  meta · {"roles":["admin"]}',
      "error handlers (dispatch order)",
      "  1. order 0 · src/errors.ts#Teapot",
    ]);
  });
});

describe("renderRouteOverview", () => {
  test("the overview lists every route with counts and a next-level expand command", () => {
    const lines = renderRouteOverview(manifest);

    expect(lines).toEqual([
      "2 routes · 1 controllers",
      'expand one route · reforce explain "<METHOD> <path>"',
      "GET /users/:id · src/users.ts#UsersController · show() · 2 middleware",
      "POST /users · src/users.ts#UsersController · create() · no middleware",
      "error handlers (dispatch order)",
      "  1. order 0 · src/errors.ts#Teapot",
    ]);
  });

  test("an application with no routes says so instead of rendering an empty table", () => {
    const lines = renderRouteOverview({ routes: [], errorHandlers: [] });

    expect(lines).toEqual(["0 routes"]);
  });
});
