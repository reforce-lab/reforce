import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, test } from "vitest";
import {
  Controller,
  ErrorHandler,
  Get,
  Middleware,
  ResponseSchema,
  ResponseStatus,
  Throws,
  Use,
} from "@/routing/decorators";
import type { RouteMiddleware } from "@/routing/middleware";
import { schemaOf } from "../support/schemas";

// 装饰器是编译期标记（ADR 0006 W3）：运行时必须保持 no-op；参数守卫只服务未经编译的调用方。

describe("route decorators stay runtime no-ops", () => {
  test("a decorated class keeps its behavior and identity", () => {
    @Controller("/users")
    class Users {
      @Get("/:id")
      show(): Response {
        return new Response("shown");
      }
    }

    const users = new Users();

    expect(users).toBeInstanceOf(Users);
    expect(users.show().status).toBe(200);
  });
});

describe("route decorator runtime guards", () => {
  test("Controller rejects a non-string path", () => {
    // 守卫服务未经编译的 JS 调用方，类型系统在这里被绕过 // justified: 见上一行
    expect(() => Controller(1 as unknown as string)).toThrow(TypeError);
  });

  test("Get rejects a non-string path", () => {
    // 守卫服务未经编译的 JS 调用方，类型系统在这里被绕过 // justified: 见上一行
    expect(() => Get(1 as unknown as string)).toThrow(TypeError);
  });

  test("Middleware rejects an unknown phase", () => {
    expect(() => Middleware({ phase: "security" as unknown as "admission" })).toThrow(TypeError);
  });

  test("Middleware rejects a non-integer order", () => {
    expect(() => Middleware({ order: 1.5 })).toThrow(TypeError);
  });

  test("ErrorHandler rejects a non-integer order", () => {
    expect(() => ErrorHandler({ order: Number.NaN })).toThrow(TypeError);
  });

  test("Use rejects a non-class argument", () => {
    // 守卫服务未经编译的 JS 调用方，类型系统在这里被绕过 // justified: 见上一行
    expect(() => Use("middleware" as unknown as new () => RouteMiddleware)).toThrow(TypeError);
  });
});

describe("response decorator runtime guards", () => {
  test("ResponseStatus accepts an in-range integer and stays a no-op", () => {
    @Controller("/orders")
    class Orders {
      @Get("/")
      @ResponseStatus(201)
      list(): { readonly ok: boolean } {
        return { ok: true };
      }
    }

    expect(new Orders().list()).toEqual({ ok: true });
  });

  test("ResponseStatus rejects a non-integer status", () => {
    expect(() => ResponseStatus(201.5)).toThrow(TypeError);
  });

  test("ResponseStatus rejects a status below 100", () => {
    expect(() => ResponseStatus(99)).toThrow(TypeError);
  });

  test("ResponseStatus rejects a status above 599", () => {
    expect(() => ResponseStatus(600)).toThrow(TypeError);
  });

  test("ResponseSchema accepts a Standard Schema and stays a no-op", () => {
    const schema = schemaOf<{ readonly name: string }>(() => ({ value: { name: "reforce" } }));

    @Controller("/users")
    class Users {
      @Get("/")
      @ResponseSchema(schema)
      show(): { readonly name: string } {
        return { name: "reforce" };
      }
    }

    expect(new Users().show()).toEqual({ name: "reforce" });
  });

  test("ResponseSchema rejects a value without a ~standard object", () => {
    // 守卫服务未经编译的 JS 调用方，类型系统在这里被绕过 // justified: 见上一行
    expect(() => ResponseSchema({} as unknown as StandardSchemaV1)).toThrow(TypeError);
  });

  test("ResponseSchema rejects a null schema", () => {
    // 守卫服务未经编译的 JS 调用方，类型系统在这里被绕过 // justified: 见上一行
    expect(() => ResponseSchema(null as unknown as StandardSchemaV1)).toThrow(TypeError);
  });

  test("Throws accepts error classes and stays a no-op", () => {
    class OrderRejected extends Error {}

    @Controller("/orders")
    class Orders {
      @Get("/")
      @Throws(OrderRejected)
      list(): { readonly ok: boolean } {
        return { ok: true };
      }
    }

    expect(new Orders().list()).toEqual({ ok: true });
  });

  test("Throws rejects a non-class argument", () => {
    // 守卫服务未经编译的 JS 调用方，类型系统在这里被绕过 // justified: 见上一行
    expect(() => Throws("boom" as unknown as new () => Error)).toThrow(TypeError);
  });
});
