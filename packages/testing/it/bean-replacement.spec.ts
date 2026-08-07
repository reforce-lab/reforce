import { defineBean } from "@reforce/core";
import { classBean, createApplicationContext, factoryBean } from "@reforce/core/generated-runtime";
import { describe, expect, test } from "vitest";
import { createTestContext } from "@/index";
import { testDefinition, testDependency, testSource } from "../test/support/test-definition";

describe("bean replacement", () => {
  test("依赖链上的所有消费者拿到替身，原实现不被构造", async () => {
    let realCreations = 0;
    class StripeGateway {
      constructor() {
        realCreations += 1;
      }
      charge(amount: number): string {
        return `stripe:${amount}`;
      }
    }
    class OrderService {
      constructor(readonly gateway: StripeGateway) {}
      place(): string {
        return this.gateway.charge(42);
      }
    }
    class CheckoutFlow {
      constructor(readonly orders: OrderService) {}
    }
    const gatewayId = "src/stripe-gateway.ts#StripeGateway";
    const ordersId = "src/order-service.ts#OrderService";
    const definition = testDefinition([
      classBean({
        id: gatewayId,
        source: testSource("stripe-gateway"),
        target: StripeGateway,
        dependencies: [],
        create: () => new StripeGateway(),
        hooks: {},
      }),
      classBean({
        id: ordersId,
        source: testSource("order-service"),
        target: OrderService,
        dependencies: [testDependency(0, gatewayId, "eager")],
        create: (resolver) => new OrderService(resolver.resolve(0)),
        hooks: {},
      }),
      classBean({
        id: "src/checkout-flow.ts#CheckoutFlow",
        source: testSource("checkout-flow"),
        target: CheckoutFlow,
        dependencies: [testDependency(0, ordersId, "eager")],
        create: (resolver) => new CheckoutFlow(resolver.resolve(0)),
        hooks: {},
      }),
    ]);
    const fake = { charge: (amount: number) => `fake:${amount}` };

    const context = await createTestContext(definition, (overrides) => {
      overrides.replace(StripeGateway, fake);
    });

    expect(context.get(StripeGateway)).toBe(fake);
    expect(context.get(OrderService).place()).toBe("fake:42");
    expect(context.get(CheckoutFlow).orders.gateway).toBe(fake);
    expect(realCreations).toBe(0);
    await context.close();
  });

  test("factory bean 按 defineBean 身份替换，消费者拿到替身", async () => {
    interface Connection {
      describe(): string;
    }
    const connection = defineBean({
      create: (): Connection => ({ describe: () => "real" }),
    });
    class Repository {
      constructor(readonly connection: Connection) {}
    }
    const connectionId = "src/connection.ts#connection";
    const definition = testDefinition([
      factoryBean({
        id: connectionId,
        source: testSource("connection"),
        definition: connection,
      }),
      classBean({
        id: "src/repository.ts#Repository",
        source: testSource("repository"),
        target: Repository,
        dependencies: [testDependency(0, connectionId, "eager")],
        create: (resolver) => new Repository(resolver.resolve(0)),
        hooks: {},
      }),
    ]);
    const fake = { describe: () => "fake" };

    const context = await createTestContext(definition, (overrides) => {
      overrides.replace(connection, fake);
    });

    expect(context.get(connection)).toBe(fake);
    expect(context.get(Repository).connection.describe()).toBe("fake");
    await context.close();
  });

  test("被替换 class bean 的生命周期钩子不执行，其余 bean 钩子照常执行", async () => {
    const events: string[] = [];
    class Telemetry {
      onContextStart(): void {
        events.push("real:start");
      }
      onContextClose(): void {
        events.push("real:close");
      }
    }
    class AuditLog {
      onContextStart(): void {
        events.push("audit:start");
      }
      onContextClose(): void {
        events.push("audit:close");
      }
    }
    const definition = testDefinition([
      classBean({
        id: "src/telemetry.ts#Telemetry",
        source: testSource("telemetry"),
        target: Telemetry,
        dependencies: [],
        create: () => new Telemetry(),
        hooks: {
          start: (bean) => bean.onContextStart(),
          close: (bean) => bean.onContextClose(),
        },
      }),
      classBean({
        id: "src/audit-log.ts#AuditLog",
        source: testSource("audit-log"),
        target: AuditLog,
        dependencies: [],
        create: () => new AuditLog(),
        hooks: {
          start: (bean) => bean.onContextStart(),
          close: (bean) => bean.onContextClose(),
        },
      }),
    ]);
    const fake = {
      onContextStart: () => {
        events.push("fake:start");
      },
      onContextClose: () => {
        events.push("fake:close");
      },
    };

    const context = await createTestContext(definition, (overrides) => {
      overrides.replace(Telemetry, fake);
    });
    await context.close();

    expect(events).toEqual(["audit:start", "audit:close"]);
  });

  test("被替换 factory bean 的 dispose 不执行", async () => {
    const disposals: string[] = [];
    const connection = defineBean({
      create: () => ({ kind: "real" }),
      dispose: (instance) => {
        disposals.push(instance.kind);
      },
    });
    const definition = testDefinition([
      factoryBean({
        id: "src/connection.ts#connection",
        source: testSource("connection"),
        definition: connection,
      }),
    ]);

    const context = await createTestContext(definition, (overrides) => {
      overrides.replace(connection, { kind: "fake" });
    });
    await context.close();

    expect(disposals).toEqual([]);
  });

  test("同一定义并行创建的测试上下文互不干扰", async () => {
    class Clock {
      now(): number {
        return 1;
      }
    }
    const definition = testDefinition([
      classBean({
        id: "src/clock.ts#Clock",
        source: testSource("clock"),
        target: Clock,
        dependencies: [],
        create: () => new Clock(),
        hooks: {},
      }),
    ]);
    const fakeFirst = { now: () => 100 };
    const fakeSecond = { now: () => 200 };

    const [first, second] = await Promise.all([
      createTestContext(definition, (overrides) => {
        overrides.replace(Clock, fakeFirst);
      }),
      createTestContext(definition, (overrides) => {
        overrides.replace(Clock, fakeSecond);
      }),
    ]);

    expect(first.get(Clock)).toBe(fakeFirst);
    expect(second.get(Clock)).toBe(fakeSecond);
    await first.close();
    expect(second.get(Clock).now()).toBe(200);
    await second.close();
  });

  test("替换不修改传入的定义", async () => {
    let realCreations = 0;
    class Repo {
      constructor() {
        realCreations += 1;
      }
      find(): string {
        return "real";
      }
    }
    const definition = testDefinition([
      classBean({
        id: "src/repo.ts#Repo",
        source: testSource("repo"),
        target: Repo,
        dependencies: [],
        create: () => new Repo(),
        hooks: {},
      }),
    ]);

    const replaced = await createTestContext(definition, (overrides) => {
      overrides.replace(Repo, { find: () => "fake" });
    });
    const plain = createApplicationContext(definition);
    await plain.start();

    expect(plain.get(Repo)).toBeInstanceOf(Repo);
    expect(realCreations).toBe(1);
    await Promise.all([replaced.close(), plain.close()]);
  });
});
