import { describe, expect, test } from "vitest";
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
    slots: [],
  };
}

function tableWith(overrides: Record<string, unknown>): unknown {
  return { schemaVersion: 2, routes: [], errorHandlers: [], ...overrides };
}

describe("validateGeneratedRouteTable", () => {
  test("accepts a complete valid table", () => {
    const table = tableWith({
      routes: [validRoute()],
      errorHandlers: [{ bean: Probe, beanId: "src/probe.ts#Probe", order: 0 }],
    });

    expect(validateGeneratedRouteTable(table) === table).toBe(true);
  });

  // 版本门是硬门(#264 决策 11):1 是旧 schemas 表的版本,旧生成物必须在启动时被拒绝,
  // 而不是带着已删除的字段静默跑进槽位执行链。
  test("rejects the retired schema version 1 and any unknown version", () => {
    expect(() => validateGeneratedRouteTable(tableWith({ schemaVersion: 1 }))).toThrow(
      InvalidRouteTableError,
    );
    expect(() => validateGeneratedRouteTable(tableWith({ schemaVersion: 3 }))).toThrow(
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

  test("rejects a route without a slots array", () => {
    const { slots: _slots, ...route } = validRoute();

    expect(() => validateGeneratedRouteTable(tableWith({ routes: [route] }))).toThrow(
      InvalidRouteTableError,
    );
  });

  test("rejects the retired schemas field as an unknown key", () => {
    const table = tableWith({ routes: [{ ...validRoute(), schemas: {} }] });

    expect(() => validateGeneratedRouteTable(table)).toThrow(/unknown field "schemas"/);
  });

  // 同 method + 同路径形状只能注册一次（#213）：编译期 DUPLICATE_ROUTE 的运行时对位，检测放在
  // 引擎无关层，各适配器因此不必各自依赖底层路由库碰巧有没有重复检测。
  test("rejects two routes with the same method and path", () => {
    const table = tableWith({ routes: [validRoute(), validRoute()] });

    expect(() => validateGeneratedRouteTable(table)).toThrow(InvalidRouteTableError);
  });

  test("rejects a duplicate shape that differs only in parameter name", () => {
    const table = tableWith({ routes: [validRoute(), { ...validRoute(), path: "/probe/:other" }] });

    expect(() => validateGeneratedRouteTable(table)).toThrow(InvalidRouteTableError);
  });

  // 引擎把 /probe/:id、//probe/:id/ 视作同一条路由（web-node 的 ignoreTrailingSlash /
  // ignoreDuplicateSlashes，#211），归一必须过滤空段才看得出这类等价重复。
  test("rejects a duplicate shape that differs only in empty segments", () => {
    const table = tableWith({ routes: [validRoute(), { ...validRoute(), path: "//probe/:id/" }] });

    expect(() => validateGeneratedRouteTable(table)).toThrow(InvalidRouteTableError);
  });

  test("names both sides of a duplicate route", () => {
    const table = tableWith({ routes: [validRoute(), { ...validRoute(), path: "/probe/:other" }] });

    expect(() => validateGeneratedRouteTable(table)).toThrow(
      /GET \/probe\/:other.*GET \/probe\/:id/,
    );
  });

  test("accepts the same path under a different method", () => {
    const table = tableWith({ routes: [validRoute(), { ...validRoute(), method: "POST" }] });

    expect(() => validateGeneratedRouteTable(table)).not.toThrow();
  });

  // 静态段优先于参数段是既有契约（web-node 的 router.spec 钉住）：两者不是同一形状，
  // 归一如果把它们并到一起，重叠路由会被误判成重复。
  test("accepts a static segment overlapping a parameter segment", () => {
    const table = tableWith({ routes: [validRoute(), { ...validRoute(), path: "/probe/self" }] });

    expect(() => validateGeneratedRouteTable(table)).not.toThrow();
  });
});

// —— 槽位与编码器字段(RFC 0012 S2,#274) ——

describe("validateGeneratedRouteTable slots and encode", () => {
  function routeWithSlots(slots: unknown): unknown {
    return { ...validRoute(), slots };
  }

  test("accepts a route with slot bindings and an encoder", () => {
    const table = tableWith({
      routes: [
        {
          ...validRoute(),
          slots: [
            { slot: "param", key: "id", decode: passthroughSchema() },
            { slot: "body", schema: passthroughSchema() },
            { slot: "requestContext" },
          ],
          encode: (value: unknown) => value,
        },
      ],
    });

    expect(() => validateGeneratedRouteTable(table)).not.toThrow();
  });

  test("rejects a slot with an unknown kind", () => {
    const table = tableWith({ routes: [routeWithSlots([{ slot: "cookie" }])] });

    expect(() => validateGeneratedRouteTable(table)).toThrow(InvalidRouteTableError);
  });

  test("rejects a slot declaring both decode and schema", () => {
    const table = tableWith({
      routes: [
        routeWithSlots([
          { slot: "query", key: "page", decode: passthroughSchema(), schema: passthroughSchema() },
        ]),
      ],
    });

    expect(() => validateGeneratedRouteTable(table)).toThrow(/both decode and schema/);
  });

  test("rejects a slot whose decode is not a standard schema", () => {
    const table = tableWith({
      routes: [routeWithSlots([{ slot: "header", key: "x-tenant", decode: {} }])],
    });

    expect(() => validateGeneratedRouteTable(table)).toThrow(InvalidRouteTableError);
  });

  test("rejects a non-string slot key", () => {
    const table = tableWith({ routes: [routeWithSlots([{ slot: "param", key: 42 }])] });

    expect(() => validateGeneratedRouteTable(table)).toThrow(/key must be a string/);
  });

  test("rejects a non-function encode", () => {
    const table = tableWith({ routes: [{ ...validRoute(), encode: "not a function" }] });

    expect(() => validateGeneratedRouteTable(table)).toThrow(/encode must be a function/);
  });
});
