import { describe, expect, test } from "bun:test";
import { defineBean, type MethodInterceptor, UnregisteredBeanTargetError } from "@reforce/context";
import {
  classBean,
  type GeneratedMethodChain,
  invokeIntercepted,
} from "@reforce/context/generated-runtime";
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

class Repo {
  async save(): Promise<string> {
    return "real";
  }
}

// 手写一份与 $Woven emission 同构的注册（ADR 0008 AM1，#202）：create 换入织入子类，
// registration.target 保持用户类——replace 的键因此不变。
function wovenDefinition() {
  const interceptorCalls: string[] = [];
  const interceptor: MethodInterceptor = {
    async intercept(context, next) {
      interceptorCalls.push(`intercepted:${context.method}`);
      return await next();
    },
  };

  class Repo$Woven extends Repo {
    constructor(private readonly chains: Readonly<Record<"save", GeneratedMethodChain>>) {
      super();
    }

    override save(): Promise<string> {
      return invokeIntercepted<Promise<string>>(this.chains.save, [], () => super.save());
    }
  }

  const definition = testDefinition([
    classBean({
      id: "src/repo.ts#Repo",
      source: testSource("repo"),
      target: Repo,
      dependencies: [],
      create: () =>
        new Repo$Woven({
          save: {
            beanId: "src/repo.ts#Repo",
            method: "save",
            entries: [{ interceptor, value: undefined }],
          },
        }),
      hooks: {},
    }),
  ]);
  return { definition, interceptorCalls };
}

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

  test("不替换的被织 bean 照常走拦截链", async () => {
    const { definition, interceptorCalls } = wovenDefinition();

    const context = await createTestContext(definition, () => undefined);
    const result = await context.get(Repo).save();

    expect(result).toBe("real");
    expect(interceptorCalls).toEqual(["intercepted:save"]);
    await context.close();
  });

  // 织入语义定案（ADR 0008 AM1，#202）：replaceCreate 整体丢弃原 create 闭包，$Woven 与
  // 链随之消失——replace 替换的是整个 bean 的行为（含织入增强，ADR 0007 口径），替身被
  // 拦截器包裹反而会引入测不到的真实事务边界。本例把该语义钉死为契约。
  test("replace 后的替身不被织入：拦截器不执行、原值直返", async () => {
    const { definition, interceptorCalls } = wovenDefinition();

    const context = await createTestContext(definition, (overrides) => {
      overrides.replace(Repo, { save: async () => "stub" });
    });
    const result = await context.get(Repo).save();

    expect(result).toBe("stub");
    expect(interceptorCalls).toEqual([]);
    await context.close();
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
