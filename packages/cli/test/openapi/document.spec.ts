import stableStringify from "json-stable-stringify";
import { describe, expect, test } from "vitest";
import { openApiDocumentOf } from "@/openapi/document";
import type {
  ManifestContractTable,
  RouteManifest,
  RouteManifestEntry,
} from "@/project/route-manifest";

// routes.json → OpenAPI 文档装配(#306):路径模板、参数展开、requestBody、三响应变体、
// @Throws 集合、auto-400 与 operationId 规则。

function routeOf(overrides: Partial<RouteManifestEntry>): RouteManifestEntry {
  return {
    method: "GET",
    path: "/probe",
    controller: {
      beanId: "src/probe.ts#ProbeController",
      handler: "show",
      exportName: "ProbeController",
    },
    middleware: [],
    meta: {},
    contract: { slots: [], response: { kind: "passthrough", errors: [] } },
    ...overrides,
  };
}

function manifestOf(routes: readonly RouteManifestEntry[]): RouteManifest {
  return { routes, errorHandlers: [] };
}

function operationAt(
  document: Record<string, unknown>,
  path: string,
  method: string,
): Record<string, unknown> {
  const paths = document.paths as Record<string, Record<string, unknown>>; // 测试断言前提:装配器恒产出 paths 树
  const operations = paths[path];
  expect(operations).toBeDefined();
  const operation = operations?.[method];
  expect(operation).toBeDefined();
  return operation as Record<string, unknown>; // 上一行已断言存在
}

const scalarTable = (scalar: "string" | "number" | "bigint"): ManifestContractTable => ({
  root: { kind: "scalar", scalar, nullable: false },
  definitions: {},
});

const queryContractTable: ManifestContractTable = {
  root: {
    kind: "object",
    nullable: false,
    fields: [
      {
        name: "page",
        optional: false,
        shape: { kind: "scalar", scalar: "number", nullable: false },
      },
      { name: "tag", optional: true, shape: { kind: "scalar", scalar: "string", nullable: false } },
    ],
  },
  definitions: {},
};

describe("openApiDocumentOf paths and parameters", () => {
  test("route params rewrite into OpenAPI templates", () => {
    const document = openApiDocumentOf(
      manifestOf([routeOf({ path: "/users/:id/orders/:orderId" })]),
    );

    expect(Object.keys(document.paths as object)).toEqual(["/users/{id}/orders/{orderId}"]);
  });

  test("single and optional-single slots become parameters with matching required flags", () => {
    const document = openApiDocumentOf(
      manifestOf([
        routeOf({
          path: "/users/:id",
          contract: {
            slots: [
              {
                slot: "param",
                key: "id",
                form: "single",
                source: { kind: "type" },
                table: scalarTable("bigint"),
              },
              {
                slot: "query",
                key: "page",
                form: "optional-single",
                source: { kind: "type" },
                table: scalarTable("number"),
              },
            ],
            response: { kind: "passthrough", errors: [] },
          },
        }),
      ]),
    );

    const operation = operationAt(document, "/users/{id}", "get");
    expect(operation.parameters).toMatchObject([
      { name: "id", in: "path", required: true, schema: { format: "int64" } },
      { name: "page", in: "query", required: false, schema: { type: "number" } },
    ]);
  });

  // 契约形态(含投影):线上参数是根对象的全部字段,投影 key 不改线上契约。
  test("a contract-form query slot expands its object fields into parameters", () => {
    const document = openApiDocumentOf(
      manifestOf([
        routeOf({
          contract: {
            slots: [
              {
                slot: "query",
                key: "page",
                form: "contract",
                source: { kind: "schema", vendor: "zod" },
                table: queryContractTable,
              },
            ],
            response: { kind: "passthrough", errors: [] },
          },
        }),
      ]),
    );

    const operation = operationAt(document, "/probe", "get");
    expect(operation.parameters).toMatchObject([
      { name: "page", in: "query", required: true },
      { name: "tag", in: "query", required: false },
    ]);
  });

  test("a body slot becomes a required application/json requestBody", () => {
    const document = openApiDocumentOf(
      manifestOf([
        routeOf({
          method: "POST",
          contract: {
            slots: [{ slot: "body", source: { kind: "type" }, table: queryContractTable }],
            response: { kind: "passthrough", errors: [] },
          },
        }),
      ]),
    );

    const operation = operationAt(document, "/probe", "post");
    expect(operation.requestBody).toMatchObject({
      required: true,
      content: { "application/json": { schema: { type: "object" } } },
    });
  });
});

describe("openApiDocumentOf responses", () => {
  test("a table response documents its status and root schema", () => {
    const document = openApiDocumentOf(
      manifestOf([
        routeOf({
          contract: {
            slots: [],
            response: { kind: "table", status: 201, table: scalarTable("string"), errors: [] },
          },
        }),
      ]),
    );

    const operation = operationAt(document, "/probe", "get");
    expect(operation.responses).toEqual({
      "201": {
        description: "Successful response.",
        content: { "application/json": { schema: { type: "string" } } },
      },
    });
  });

  test("a free-form response documents an open object", () => {
    const document = openApiDocumentOf(
      manifestOf([
        routeOf({
          contract: { slots: [], response: { kind: "free-form", status: 200, errors: [] } },
        }),
      ]),
    );

    const operation = operationAt(document, "/probe", "get");
    expect(operation.responses).toMatchObject({
      "200": { content: { "application/json": { schema: { type: "object" } } } },
    });
  });

  // passthrough 无状态码:形状与码都静态不可知,落 default,不猜。
  test("a statusless passthrough response lands under default without content", () => {
    const document = openApiDocumentOf(manifestOf([routeOf({})]));

    const operation = operationAt(document, "/probe", "get");
    const responses = operation.responses as Record<string, Record<string, unknown>>;
    expect(Object.keys(responses)).toEqual(["default"]);
    expect(responses.default?.content).toBeUndefined();
  });

  test("@Throws entries group by status and dedupe identical bodies into one schema", () => {
    const errorBody: ManifestContractTable = {
      root: {
        kind: "object",
        nullable: false,
        fields: [
          {
            name: "code",
            optional: false,
            shape: { kind: "scalar", scalar: "string", nullable: false },
          },
        ],
      },
      definitions: {},
    };
    const document = openApiDocumentOf(
      manifestOf([
        routeOf({
          contract: {
            slots: [],
            response: {
              kind: "table",
              status: 200,
              table: scalarTable("string"),
              errors: [
                {
                  error: "OrderRejectedError",
                  handler: "src/errors.ts#Rejected",
                  status: 409,
                  body: { kind: "table", table: errorBody },
                },
                {
                  error: "DuplicateOrderError",
                  handler: "src/errors.ts#Rejected",
                  status: 409,
                  body: { kind: "table", table: errorBody },
                },
                { error: "QuotaExceededError", handler: "src/errors.ts#Quota", status: 429 },
              ],
            },
          },
        }),
      ]),
    );

    const operation = operationAt(document, "/probe", "get");
    const responses = operation.responses as Record<string, Record<string, unknown>>;
    expect(responses["409"]).toMatchObject({
      description: "Declared by @Throws: OrderRejectedError, DuplicateOrderError.",
      content: { "application/json": { schema: { type: "object" } } },
    });
    // 无 body 的条目(passthrough 处理器)有状态码就有响应行,只是没有 content。
    expect(responses["429"]?.content).toBeUndefined();
    expect(responses["429"]?.description).toBe("Declared by @Throws: QuotaExceededError.");
  });

  // defineHttpError 条目(#310):problem 变体走 application/problem+json,code 字面量钉 const;
  // 无 status 的条目(defineHttpError 实参非字面量)没有可写的响应行,与 passthrough 同口径。
  test("a handlerless problem entry renders problem+json with a pinned code", () => {
    const document = openApiDocumentOf(
      manifestOf([
        routeOf({
          contract: {
            slots: [],
            response: {
              kind: "passthrough",
              errors: [
                {
                  error: "PaymentRequiredError",
                  status: 402,
                  body: { kind: "problem", code: "PAYMENT_REQUIRED_X" },
                },
                { error: "TeapotDynamicError", body: { kind: "problem" } },
              ],
            },
          },
        }),
      ]),
    );

    const operation = operationAt(document, "/probe", "get");
    const responses = operation.responses as Record<string, Record<string, unknown>>;
    expect(responses["402"]).toEqual({
      description: "Declared by @Throws: PaymentRequiredError.",
      content: {
        "application/problem+json": {
          schema: {
            type: "object",
            properties: {
              type: { type: "string" },
              title: { type: "string" },
              status: { type: "integer" },
              detail: { type: "string" },
              code: { type: "string", const: "PAYMENT_REQUIRED_X" },
            },
            required: ["type", "title", "status", "detail", "code"],
          },
        },
      },
    });
    expect(Object.keys(responses)).not.toContain("418");
  });

  test("problem and handler bodies on the same status keep separate media types", () => {
    const document = openApiDocumentOf(
      manifestOf([
        routeOf({
          contract: {
            slots: [],
            response: {
              kind: "passthrough",
              errors: [
                {
                  error: "ConflictError",
                  handler: "src/errors.ts#Conflict",
                  status: 409,
                  body: { kind: "free-form" },
                },
                { error: "DuplicateError", status: 409, body: { kind: "problem", code: "DUP" } },
              ],
            },
          },
        }),
      ]),
    );

    const operation = operationAt(document, "/probe", "get");
    const responses = operation.responses as Record<string, Record<string, unknown>>;
    expect(responses["409"]).toMatchObject({
      description: "Declared by @Throws: ConflictError, DuplicateError.",
      content: {
        "application/json": { schema: { type: "object" } },
        "application/problem+json": { schema: { properties: { code: { const: "DUP" } } } },
      },
    });
  });

  test("a route with a data slot gains the shared auto-400 validation response", () => {
    const document = openApiDocumentOf(
      manifestOf([
        routeOf({
          contract: {
            slots: [
              {
                slot: "query",
                key: "page",
                form: "single",
                source: { kind: "type" },
                table: scalarTable("number"),
              },
            ],
            response: { kind: "passthrough", errors: [] },
          },
        }),
      ]),
    );

    const operation = operationAt(document, "/probe", "get");
    const responses = operation.responses as Record<string, unknown>;
    expect(responses["400"]).toMatchObject({
      content: {
        "application/problem+json": {
          schema: { $ref: "#/components/schemas/ReforceValidationProblem" },
        },
      },
    });
    const components = document.components as Record<string, Record<string, unknown>>;
    expect(components.schemas?.ReforceValidationProblem).toBeDefined();
  });

  test("a route without data slots has neither auto-400 nor the validation component", () => {
    const document = openApiDocumentOf(manifestOf([routeOf({})]));

    const operation = operationAt(document, "/probe", "get");
    expect((operation.responses as Record<string, unknown>)["400"]).toBeUndefined();
    expect(document.components).toBeUndefined();
  });
});

describe("openApiDocumentOf operations", () => {
  test("operationId joins export name and handler; the tag is the controller export name", () => {
    const document = openApiDocumentOf(manifestOf([routeOf({})]));

    const operation = operationAt(document, "/probe", "get");
    expect(operation.operationId).toBe("ProbeController_show");
    expect(operation.tags).toEqual(["ProbeController"]);
  });

  test("colliding operationIds pick up a method suffix", () => {
    const document = openApiDocumentOf(
      manifestOf([routeOf({ method: "GET" }), routeOf({ method: "HEAD" })]),
    );

    expect(operationAt(document, "/probe", "get").operationId).toBe("ProbeController_show_get");
    expect(operationAt(document, "/probe", "head").operationId).toBe("ProbeController_show_head");
  });

  // 组件与文档字节确定性:同一份表无论 definitions 键序如何,stable stringify 输出一致。
  test("the rendered document is byte-identical regardless of definition insertion order", () => {
    const forward: ManifestContractTable = {
      root: { kind: "reference", target: "src/a.ts#A", nullable: false },
      definitions: {
        "src/a.ts#A": { typeName: "A", shape: { kind: "object", nullable: false, fields: [] } },
        "src/b.ts#B": { typeName: "B", shape: { kind: "object", nullable: false, fields: [] } },
      },
    };
    const backward: ManifestContractTable = {
      root: forward.root,
      definitions: {
        "src/b.ts#B": { typeName: "B", shape: { kind: "object", nullable: false, fields: [] } },
        "src/a.ts#A": { typeName: "A", shape: { kind: "object", nullable: false, fields: [] } },
      },
    };
    const routeWith = (table: ManifestContractTable): RouteManifestEntry =>
      routeOf({
        contract: { slots: [], response: { kind: "table", status: 200, table, errors: [] } },
      });

    const first = stableStringify(openApiDocumentOf(manifestOf([routeWith(forward)])), {
      space: 2,
    });
    const second = stableStringify(openApiDocumentOf(manifestOf([routeWith(backward)])), {
      space: 2,
    });

    expect(first).toBeDefined();
    expect(first).toBe(second);
  });

  test("the document head pins the OpenAPI version and a placeholder info block", () => {
    const document = openApiDocumentOf(manifestOf([]));

    expect(document.openapi).toBe("3.2.0");
    expect(document.info).toEqual({ title: "Reforce application", version: "0.0.0" });
  });
});
