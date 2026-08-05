import { describe, expect, test } from "vitest";
import { defineMethodMarker } from "@/interception/method-marker";

// 标记是编译期元数据（ADR 0008 AM1，#202）：运行时必须保持 no-op；守卫只服务未经编译的调用方。

describe("defineMethodMarker declaration guards", () => {
  test("rejects an empty key", () => {
    expect(() => defineMethodMarker("")).toThrow(TypeError);
  });

  test("rejects a non-string key", () => {
    // 守卫服务未经编译的 JS 调用方，类型系统在这里被绕过 // justified: 见上一行
    expect(() => defineMethodMarker(1 as unknown as string)).toThrow(TypeError);
  });

  test("exposes the key on a frozen marker", () => {
    const Audited = defineMethodMarker<{ label: string }>("audited");

    expect(Audited.key).toBe("audited");
    expect(Object.isFrozen(Audited)).toBe(true);
  });
});

describe("method marker decorators stay runtime no-ops", () => {
  test("a marked method keeps its behavior", async () => {
    const Audited = defineMethodMarker<{ label: string }>("audited");

    class Sample {
      @Audited({ label: "save" })
      async save(): Promise<string> {
        return "saved";
      }
    }

    await expect(new Sample().save()).resolves.toBe("saved");
  });

  test("a marker whose value type includes undefined allows a bare call", async () => {
    const Traced = defineMethodMarker<{ detail: boolean } | undefined>("traced");

    class Sample {
      @Traced()
      async run(): Promise<number> {
        return 7;
      }
    }

    await expect(new Sample().run()).resolves.toBe(7);
  });
});

describe("method marker runtime guards", () => {
  test("rejects more than one literal value", () => {
    const Audited = defineMethodMarker<{ label: string }>("audited");
    // 0/1 参在类型层由条件元组钉死，这里验证未经类型检查调用方撞到的运行时守卫
    // // justified: 见上一行
    const call = Audited as unknown as (...args: readonly unknown[]) => unknown;

    expect(() => call({ label: "a" }, { label: "b" })).toThrow(TypeError);
  });

  test("the returned decorator rejects a class position", () => {
    const Audited = defineMethodMarker<{ label: string }>("audited");
    // 类位置在类型层已被 ClassMethodDecoratorContext 拒绝，这里验证运行时双保险
    // // justified: 见上一行
    const decorate = Audited({ label: "x" }) as unknown as (
      value: unknown,
      context: { readonly kind: string },
    ) => void;

    expect(() => decorate(class {}, { kind: "class" })).toThrow(TypeError);
  });
});
