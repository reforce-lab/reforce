import type {
  ApplicationContext,
  BeanClass,
  BeanDefinition,
  ContextStartReport,
} from "@reforce/core";
import { describe, expect, test } from "vitest";
import type { WebApplication, WebApplicationHandle } from "@/adapter";
import { connectWebApplication } from "@/execution/connect";

// connect 是生成的 bootstrap 的接线入口（#153）：这里用替身容器验证编排契约——引擎按序
// 启动、close 先排空引擎再关容器、启动失败回收。真实容器与真实引擎分别由 web/it 与
// @reforce/web-node 的 IT 覆盖。

const emptyTable = { schemaVersion: 4, routes: [], errorHandlers: [] };

class FakeContext implements ApplicationContext {
  readonly events: string[] = [];
  private readonly instances = new Map<object, object>();

  register(target: BeanClass, instance: object): void {
    this.instances.set(target, instance);
  }

  start(): Promise<ContextStartReport> {
    this.events.push("context:start");
    return Promise.resolve({ beanTimings: [] });
  }

  get<T extends object>(target: BeanClass<T> | BeanDefinition<T>): T {
    const instance = this.instances.get(target);
    if (instance === undefined) {
      throw new Error("unregistered target");
    }
    // 替身容器按注册表返回实例，类型由注册方保证 // justified: 测试替身的身份映射
    return instance as T;
  }

  runInRequestScope<R>(_seeds: never[], callback: () => R): Promise<Awaited<R>> {
    return Promise.resolve(callback()) as Promise<Awaited<R>>;
  }

  close(): Promise<void> {
    this.events.push("context:close");
    return Promise.resolve();
  }
}

class RecordingEngine {
  readonly name = "recording";

  constructor(
    private readonly label: string,
    private readonly events: string[],
    private readonly failure?: { readonly on: "close" | "start" },
  ) {}

  start(_application: WebApplication): WebApplicationHandle {
    if (this.failure?.on === "start") {
      throw new Error(`${this.label} start failed`);
    }
    this.events.push(`${this.label}:start`);
    return {
      close: () => {
        if (this.failure?.on === "close") {
          return Promise.reject(new Error(`${this.label} close failed`));
        }
        this.events.push(`${this.label}:close`);
        return Promise.resolve();
      },
    };
  }
}

class EngineAlpha extends RecordingEngine {}
class EngineBeta extends RecordingEngine {}

function connected(context: FakeContext, engines: readonly BeanClass<RecordingEngine>[]) {
  return connectWebApplication({ context, table: emptyTable, engines });
}

describe("connectWebApplication", () => {
  test("zero engines hands the context back untouched", async () => {
    const context = new FakeContext();

    const application = await connectWebApplication({ context, table: emptyTable, engines: [] });

    expect(application).toBe(context);
  });

  test("engines start in array order and close in reverse before the context", async () => {
    const context = new FakeContext();
    context.register(EngineAlpha, new EngineAlpha("alpha", context.events));
    context.register(EngineBeta, new EngineBeta("beta", context.events));

    const application = await connected(context, [EngineAlpha, EngineBeta]);
    await application.close();

    expect(context.events).toEqual([
      "alpha:start",
      "beta:start",
      "beta:close",
      "alpha:close",
      "context:close",
    ]);
  });

  test("close is idempotent and returns the same completion", async () => {
    const context = new FakeContext();
    context.register(EngineAlpha, new EngineAlpha("alpha", context.events));

    const application = await connected(context, [EngineAlpha]);
    await Promise.all([application.close(), application.close()]);
    await application.close();

    expect(context.events.filter((event) => event === "context:close")).toHaveLength(1);
    expect(context.events.filter((event) => event === "alpha:close")).toHaveLength(1);
  });

  test("a failing engine start closes started engines and the context, then rethrows", async () => {
    const context = new FakeContext();
    context.register(EngineAlpha, new EngineAlpha("alpha", context.events));
    context.register(EngineBeta, new EngineBeta("beta", context.events, { on: "start" }));

    await expect(connected(context, [EngineAlpha, EngineBeta])).rejects.toThrow(
      "beta start failed",
    );

    expect(context.events).toEqual(["alpha:start", "alpha:close", "context:close"]);
  });

  test("an engine close failure still closes the context and surfaces as AggregateError", async () => {
    const context = new FakeContext();
    context.register(EngineAlpha, new EngineAlpha("alpha", context.events, { on: "close" }));

    const application = await connected(context, [EngineAlpha]);

    await expect(application.close()).rejects.toBeInstanceOf(AggregateError);
    expect(context.events).toEqual(["alpha:start", "context:close"]);
  });
});
