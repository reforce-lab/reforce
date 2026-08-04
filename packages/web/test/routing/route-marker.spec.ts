import { describe, expect, test } from "bun:test";
import { defineRouteMarker } from "@/routing/route-marker";

describe("defineRouteMarker", () => {
  test("produces a keyed no-op decorator factory", () => {
    const Roles = defineRouteMarker<readonly string[]>("roles");

    class Guarded {
      @Roles(["admin"])
      show(): string {
        return "shown";
      }
    }

    expect(Roles.key).toBe("roles");
    expect(new Guarded().show()).toBe("shown");
  });

  test("rejects an empty key", () => {
    expect(() => defineRouteMarker("")).toThrow(TypeError);
  });

  test("rejects a non-string key", () => {
    // 守卫服务未经编译的 JS 调用方，类型系统在这里被绕过 // justified: 见上一行
    expect(() => defineRouteMarker(7 as unknown as string)).toThrow(TypeError);
  });
});
