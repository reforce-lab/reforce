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
      contract: {
        slots: [
          { slot: "param", key: "id", form: "single", source: { kind: "type" } },
          { slot: "query", key: "page", form: "optional-single", source: { kind: "type" } },
          { slot: "body", source: { kind: "schema", vendor: "zod" } },
          { slot: "requestContext" },
        ],
        response: "table",
      },
    },
    {
      method: "POST",
      path: "/users",
      controller: { beanId: "src/users.ts#UsersController", handler: "create" },
      middleware: [],
      meta: {},
      contract: { slots: [], response: "passthrough" },
    },
  ],
  errorHandlers: [{ beanId: "src/errors.ts#Teapot", order: 0 }],
};

// 落盘形态的 contract 节(source 是 {source: "..."} 判别对象),parseRouteManifestBytes 的
// 输入按它构造;上面的 RouteManifest 是解析后的内存形态。
function manifestJson(): unknown {
  return {
    schemaVersion: 2,
    errorHandlers: manifest.errorHandlers,
    routes: manifest.routes.map((route) => ({
      ...route,
      contract: {
        slots: route.contract.slots.map((slot) => ({
          slot: slot.slot,
          ...(slot.key === undefined ? {} : { key: slot.key }),
          ...(slot.form === undefined ? {} : { form: slot.form }),
          ...(slot.source === undefined
            ? {}
            : {
                source: {
                  source: slot.source.kind,
                  ...(slot.source.vendor === undefined ? {} : { vendor: slot.source.vendor }),
                },
              }),
        })),
        response: { kind: route.contract.response },
      },
    })),
  };
}

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
  test("a valid manifest round-trips into slot lines", () => {
    const parsed = parseRouteManifestBytes(encoded(manifestJson()));

    expect(parsed?.routes).toHaveLength(2);
    expect(parsed?.routes[0]?.contract).toEqual(manifest.routes[0]?.contract);
    expect(parsed?.errorHandlers).toEqual([{ beanId: "src/errors.ts#Teapot", order: 0 }]);
  });

  // 1 是旧 schemas 表的版本:旧生成物不得被静默解释成槽位表。
  test("a wrong schema version is rejected", () => {
    expect(
      parseRouteManifestBytes(encoded({ schemaVersion: 1, routes: [], errorHandlers: [] })),
    ).toBeUndefined();
    expect(
      parseRouteManifestBytes(encoded({ schemaVersion: 3, routes: [], errorHandlers: [] })),
    ).toBeUndefined();
  });

  test("a malformed route entry is rejected", () => {
    const bytes = encoded({
      schemaVersion: 2,
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
  // 键名打印(RFC 0012 S2,#274 owner 拍板):可选键 typo 在运行时静默,这里是唯一排查入口,
  // 每个参数的槽位、实际监听键名与契约来源逐行如实转述。
  test("a route renders handler, flattened chain, slot keys, meta, and error handlers", () => {
    const lines = renderRouteExplanation(manifest, matchRoutes(manifest, { path: "/users/42" }));

    expect(lines).toEqual([
      "GET /users/:id",
      "  handler src/users.ts#UsersController · show()",
      "  middleware chain (outer → inner) · flattened at compile time by (phase, order, beanId)",
      "  1. observability · order 0 · global · src/trace.ts#Trace",
      "  2. admission · order 0 · global · src/guard.ts#Guard",
      "  inputs (handler parameter order)",
      "  1. param · key id · decoded from the type",
      "  2. query · key page · optional · decoded from the type",
      "  3. body · decoded by schema (zod)",
      "  4. requestContext",
      "  response · whitelisted by the return type contract",
      '  meta · {"roles":["admin"]}',
      "error handlers (dispatch order)",
      "  1. order 0 · src/errors.ts#Teapot",
    ]);
  });

  test("a route without data slots prints no inputs section", () => {
    const lines = renderRouteExplanation(
      manifest,
      matchRoutes(manifest, { method: "POST", path: "/users" }),
    );

    expect(lines.some((line) => line.includes("inputs"))).toBe(false);
    expect(lines.some((line) => line.includes("response ·"))).toBe(false);
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
