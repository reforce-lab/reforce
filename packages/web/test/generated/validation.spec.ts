import { describe, expect, test } from "bun:test";
import { InvalidRouteTableError } from "@/errors";
import type { GeneratedRoute } from "@/generated/route-table";
import { validateGeneratedRouteTable } from "@/generated/validation";
import { passthroughSchema } from "../support/schemas";

// 一个类同时充当 controller/中间件/错误处理器目标：校验只看结构形状，类型面由 handle 满足。
class Probe {
  show(): Response {
    return new Response("ok");
  }

  handle(): Response {
    return new Response("ok");
  }
}

function validRoute(): GeneratedRoute {
  return {
    method: "GET",
    path: "/probe/:id",
    controller: Probe,
    beanId: "src/probe.ts#Probe",
    handler: "show",
    invoke: (instance) => Reflect.apply(Probe.prototype.show, instance, []),
    middleware: [
      {
        bean: Probe,
        beanId: "src/probe.ts#Probe",
        phase: "admission",
        order: -1,
        mount: "controller",
      },
    ],
    meta: { roles: ["admin"], limit: 3 },
    schemas: { body: passthroughSchema() },
  };
}

function tableWith(overrides: Record<string, unknown>): unknown {
  return { schemaVersion: 1, routes: [], errorHandlers: [], ...overrides };
}

describe("validateGeneratedRouteTable", () => {
  test("accepts a complete valid table", () => {
    const table = tableWith({
      routes: [validRoute()],
      errorHandlers: [{ bean: Probe, beanId: "src/probe.ts#Probe", order: 0 }],
    });

    expect(validateGeneratedRouteTable(table) === table).toBe(true);
  });

  test("rejects an unknown schema version", () => {
    expect(() => validateGeneratedRouteTable(tableWith({ schemaVersion: 2 }))).toThrow(
      InvalidRouteTableError,
    );
  });

  test("rejects an unknown top-level key", () => {
    expect(() => validateGeneratedRouteTable(tableWith({ extra: true }))).toThrow(
      InvalidRouteTableError,
    );
  });

  test("rejects an unsupported HTTP method", () => {
    const table = tableWith({ routes: [{ ...validRoute(), method: "TRACE" }] });

    expect(() => validateGeneratedRouteTable(table)).toThrow(InvalidRouteTableError);
  });

  test("rejects a path without a leading slash", () => {
    const table = tableWith({ routes: [{ ...validRoute(), path: "probe" }] });

    expect(() => validateGeneratedRouteTable(table)).toThrow(InvalidRouteTableError);
  });

  test("rejects a middleware entry with an unknown phase", () => {
    const route = validRoute();
    const table = tableWith({
      routes: [
        {
          ...route,
          middleware: [{ ...route.middleware[0], phase: "security" }],
        },
      ],
    });

    expect(() => validateGeneratedRouteTable(table)).toThrow(InvalidRouteTableError);
  });

  test("rejects meta values outside the JSON literal tree", () => {
    const table = tableWith({ routes: [{ ...validRoute(), meta: { stamp: 1n } }] });

    expect(() => validateGeneratedRouteTable(table)).toThrow(InvalidRouteTableError);
  });

  test("rejects a schema slot without ~standard.validate", () => {
    const table = tableWith({ routes: [{ ...validRoute(), schemas: { body: {} } }] });

    expect(() => validateGeneratedRouteTable(table)).toThrow(InvalidRouteTableError);
  });
});
