import { describe, expect, test } from "vitest";
import {
  type ManifestContractTable,
  parseRouteManifestBytes,
  type RouteManifest,
} from "@/project/route-manifest";

// routes.json 解析(#306):整份拒收纪律——任何一处形状不对返回 undefined,不出半份表。
// 这里既测概要面(explain 消费),也测字段表全量解析(openapi 消费)。

function encoded(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const userTable: ManifestContractTable = {
  root: { kind: "reference", target: "src/users.ts#User", nullable: false },
  definitions: {
    "src/users.ts#User": {
      typeName: "User",
      shape: {
        kind: "object",
        nullable: false,
        fields: [
          {
            name: "id",
            optional: false,
            shape: { kind: "scalar", scalar: "bigint", nullable: false },
          },
          {
            name: "tags",
            optional: true,
            shape: {
              kind: "array",
              nullable: false,
              element: { kind: "scalar", scalar: "string", nullable: true },
            },
          },
        ],
      },
    },
  },
};

function manifestJson(): unknown {
  return {
    schemaVersion: 3,
    routes: [
      {
        method: "GET",
        path: "/users/:id",
        controller: {
          beanId: "src/users.ts#UsersController",
          handler: "show",
          exportName: "UsersController",
          moduleSpecifier: "../../src/users.js",
        },
        middleware: [],
        meta: {},
        contract: {
          slots: [
            {
              slot: "param",
              key: "id",
              form: "single",
              source: { source: "type" },
              table: {
                root: { kind: "scalar", scalar: "bigint", nullable: false },
                definitions: {},
              },
            },
          ],
          response: {
            kind: "table",
            status: 200,
            source: { source: "type" },
            table: userTable,
            errors: [
              {
                error: "OrderRejectedError",
                handler: "src/errors.ts#OrderRejected",
                status: 409,
                body: {
                  kind: "table",
                  table: {
                    root: {
                      kind: "object",
                      nullable: false,
                      fields: [
                        {
                          name: "code",
                          optional: false,
                          shape: {
                            kind: "literal",
                            nullable: false,
                            values: [{ scalar: "string", value: "rejected" }],
                          },
                        },
                      ],
                    },
                    definitions: {},
                  },
                },
              },
            ],
          },
        },
      },
    ],
    errorHandlers: [
      {
        beanId: "src/errors.ts#OrderRejected",
        order: 0,
        accepts: { name: "OrderRejectedError", moduleSpecifier: "../../src/errors.js" },
        status: 409,
        body: { kind: "free-form" },
      },
    ],
  };
}

describe("parseRouteManifestBytes", () => {
  test("a valid v3 manifest parses slots, tables, thrown errors, and handlers", () => {
    const parsed = parseRouteManifestBytes(encoded(manifestJson()));

    expect(parsed).toBeDefined();
    const route = parsed?.routes[0];
    expect(route?.controller).toEqual({
      beanId: "src/users.ts#UsersController",
      handler: "show",
      exportName: "UsersController",
    });
    expect(route?.contract.slots[0]?.table?.root).toEqual({
      kind: "scalar",
      scalar: "bigint",
      nullable: false,
    });
    expect(route?.contract.response.table).toEqual(userTable);
    expect(route?.contract.response.errors[0]?.body?.kind).toBe("table");
    expect(parsed?.errorHandlers[0]).toEqual({
      beanId: "src/errors.ts#OrderRejected",
      order: 0,
      accepts: { name: "OrderRejectedError" },
      status: 409,
      body: { kind: "free-form" },
    });
  });

  test("every contract shape kind survives a parse round-trip", () => {
    const table: ManifestContractTable = {
      root: {
        kind: "union",
        nullable: true,
        discriminant: "kind",
        members: [
          {
            tag: { scalar: "string", value: "user" },
            shape: { kind: "reference", target: "src/users.ts#User", nullable: false },
          },
          {
            tag: { scalar: "string", value: "guest" },
            shape: {
              kind: "object",
              nullable: false,
              fields: [
                {
                  name: "kind",
                  optional: false,
                  shape: {
                    kind: "literal",
                    nullable: false,
                    values: [{ scalar: "string", value: "guest" }],
                  },
                },
                {
                  name: "since",
                  optional: false,
                  shape: { kind: "scalar", scalar: "date", nullable: true },
                },
              ],
            },
          },
        ],
      },
      definitions: userTable.definitions,
    };
    const bytes = encoded({
      schemaVersion: 3,
      routes: [
        {
          method: "GET",
          path: "/who",
          controller: { beanId: "src/who.ts#WhoController", handler: "show" },
          middleware: [],
          meta: {},
          contract: {
            slots: [],
            response: { kind: "table", status: 200, table, errors: [] },
          },
        },
      ],
      errorHandlers: [],
    });

    const parsed = parseRouteManifestBytes(bytes);

    expect(parsed?.routes[0]?.contract.response.table).toEqual(table);
  });

  // 1/2 是旧表的版本:旧生成物不得被静默解释成 v3 表。
  test("a wrong schema version is rejected", () => {
    for (const schemaVersion of [1, 2, 4]) {
      expect(
        parseRouteManifestBytes(encoded({ schemaVersion, routes: [], errorHandlers: [] })),
      ).toBeUndefined();
    }
  });

  test("a malformed route entry rejects the whole manifest", () => {
    const bytes = encoded({
      schemaVersion: 3,
      routes: [{ method: "GET" }],
      errorHandlers: [],
    });

    expect(parseRouteManifestBytes(bytes)).toBeUndefined();
  });

  // 「有表但读不出」不得静默降级成「本就无表」:openapi 会把这样的路由当 bare 槽漏掉参数。
  test("a slot with a malformed table rejects the whole manifest", () => {
    const bytes = encoded({
      schemaVersion: 3,
      routes: [
        {
          method: "GET",
          path: "/users",
          controller: { beanId: "src/users.ts#UsersController", handler: "list" },
          middleware: [],
          meta: {},
          contract: {
            slots: [
              {
                slot: "query",
                form: "contract",
                source: { source: "type" },
                table: { root: { kind: "mystery", nullable: false }, definitions: {} },
              },
            ],
            response: { kind: "free-form", status: 200, errors: [] },
          },
        },
      ],
      errorHandlers: [],
    });

    expect(parseRouteManifestBytes(bytes)).toBeUndefined();
  });

  test("a thrown error with a malformed body rejects the whole manifest", () => {
    const bytes = encoded({
      schemaVersion: 3,
      routes: [
        {
          method: "GET",
          path: "/users",
          controller: { beanId: "src/users.ts#UsersController", handler: "list" },
          middleware: [],
          meta: {},
          contract: {
            slots: [],
            response: {
              kind: "free-form",
              status: 200,
              errors: [
                {
                  error: "BoomError",
                  handler: "src/errors.ts#Boom",
                  status: 500,
                  body: { kind: "table" },
                },
              ],
            },
          },
        },
      ],
      errorHandlers: [],
    });

    expect(parseRouteManifestBytes(bytes)).toBeUndefined();
  });

  test("an empty manifest parses to empty collections", () => {
    const parsed = parseRouteManifestBytes(
      encoded({ schemaVersion: 3, routes: [], errorHandlers: [] }),
    );

    expect(parsed).toEqual({ routes: [], errorHandlers: [] } satisfies RouteManifest);
  });
});
