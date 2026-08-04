import { describe, expect, test } from "bun:test";
import { Controller, ErrorHandler, Get, Middleware, Use } from "@/routing/decorators";

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

  test("Get rejects a non-object schemas argument", () => {
    // 守卫服务未经编译的 JS 调用方，类型系统在这里被绕过 // justified: 见上一行
    expect(() => Get("/users", "schema" as unknown as Record<string, never>)).toThrow(TypeError);
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
    expect(() => Use("middleware" as unknown as new () => object)).toThrow(TypeError);
  });
});
