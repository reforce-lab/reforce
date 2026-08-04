import { describe, expect, test } from "bun:test";
import { defineBean, UnregisteredBeanTargetError } from "@reforce/context";
import { classBean } from "@reforce/context/generated-runtime";
import { createTestContext, type TestContextOverrides } from "@/test-context";
import { testDefinition, testSource } from "./support/test-definition";

class Service {
  ping(): string {
    return "real";
  }
}

function serviceDefinition() {
  return testDefinition([
    classBean({
      id: "src/service.ts#Service",
      source: testSource("service"),
      target: Service,
      dependencies: [],
      create: () => new Service(),
      hooks: {},
    }),
  ]);
}

// tsc 层验收（ADR 0007 T2，#143）：结构不兼容的替身必须是编译错。任一 @ts-expect-error
// 失去作用（例如 NoInfer 被移除后 T 被放宽成联合类型），typecheck 会报未使用的指令。
function verifyReplaceRejectsIncompatibleStubs(overrides: TestContextOverrides): void {
  const cacheBean = defineBean({ create: () => ({ read: (key: string) => key }) });
  const richFake = { ping: () => "fake", calls: 0 };

  overrides.replace(Service, richFake);
  // @ts-expect-error 替身缺少被替换 bean 的成员必须是编译错。
  overrides.replace(Service, {});
  // @ts-expect-error 方法返回类型不兼容必须是编译错。
  overrides.replace(Service, { ping: () => 1 });
  overrides.replace(cacheBean, { read: (key: string) => `fake:${key}` });
  // @ts-expect-error defineBean 替身参数类型不兼容必须是编译错。
  overrides.replace(cacheBean, { read: (key: number) => `${key}` });
}
void verifyReplaceRejectsIncompatibleStubs;

describe("createTestContext", () => {
  test("空替换表的上下文提供原实现", async () => {
    const context = await createTestContext(serviceDefinition(), () => undefined);

    expect(context.get(Service)).toBeInstanceOf(Service);
    await context.close();
  });

  test("未注册的替换目标被拒绝", async () => {
    class Unknown {}

    const creation = createTestContext(serviceDefinition(), (overrides) => {
      overrides.replace(Unknown, new Unknown());
    });

    await expect(creation).rejects.toBeInstanceOf(UnregisteredBeanTargetError);
  });

  test("同一 Bean 目标重复 replace 被拒绝", async () => {
    const creation = createTestContext(serviceDefinition(), (overrides) => {
      overrides.replace(Service, { ping: () => "first" });
      overrides.replace(Service, { ping: () => "second" });
    });

    await expect(creation).rejects.toThrow(TypeError);
    await expect(creation).rejects.toThrow("already called for this Bean target");
  });

  test("原始值替身被拒绝", async () => {
    const creation = createTestContext(serviceDefinition(), (overrides) => {
      const replace: (target: unknown, replacement: unknown) => void = overrides.replace as never; // 模拟未编译的 JS 调用方：类型系统故意拒绝这些实参，绕过以覆盖运行时守卫。
      replace(Service, "stub");
    });

    await expect(creation).rejects.toThrow(TypeError);
    await expect(creation).rejects.toThrow("replacement must be an object");
  });

  test("原始值替换目标被拒绝", async () => {
    const creation = createTestContext(serviceDefinition(), (overrides) => {
      const replace: (target: unknown, replacement: unknown) => void = overrides.replace as never; // 模拟未编译的 JS 调用方：类型系统故意拒绝这些实参，绕过以覆盖运行时守卫。
      replace("Service", { ping: () => "fake" });
    });

    await expect(creation).rejects.toThrow(TypeError);
    await expect(creation).rejects.toThrow("target must be a Bean Class");
  });

  test("异步配置回调被拒绝", async () => {
    const creation = createTestContext(serviceDefinition(), async () => undefined);

    await expect(creation).rejects.toThrow(TypeError);
    await expect(creation).rejects.toThrow("must be synchronous");
  });

  test("配置回调返回后 replace 立即失效", async () => {
    let escaped: TestContextOverrides | undefined;
    const context = await createTestContext(serviceDefinition(), (overrides) => {
      escaped = overrides;
    });

    expect(() => escaped?.replace(Service, { ping: () => "late" })).toThrow(
      "must be called synchronously",
    );
    await context.close();
  });
});
