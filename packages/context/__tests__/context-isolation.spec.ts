import { describe, expect, test } from "bun:test";
import { classBean, createApplicationContext, factoryBean } from "#internal/generated-runtime";
import { ApplicationContextStateError, defineBean } from "#internal/index";
import { testDefinition, testDependency, testSource } from "#test-support/test-definition";

describe("context isolation", () => {
  test("two contexts create and clean independent instance state", async () => {
    let creations = 0;
    const disposed: number[] = [];
    const definition = defineBean({
      create: () => ({ marker: ++creations }),
      dispose: (instance) => {
        disposed.push(instance.marker);
      },
    });
    const generated = testDefinition([
      factoryBean({
        id: "src/resource.ts#resource",
        source: testSource("resource"),
        definition,
      }),
    ]);
    const first = createApplicationContext(generated);
    const second = createApplicationContext(generated);

    await Promise.all([first.start(), second.start()]);

    expect(first.get(definition)).not.toBe(second.get(definition));
    await first.close();
    expect(disposed).toEqual([1]);
    expect(second.get(definition).marker).toBe(2);
    await second.close();
    expect(disposed).toEqual([1, 2]);
  });

  test("two contexts account separately for a factory returning one shared object", async () => {
    const shared = {};
    let creations = 0;
    let disposals = 0;
    const definition = defineBean({
      create: () => {
        creations += 1;
        return shared;
      },
      dispose: () => {
        disposals += 1;
      },
    });
    const generated = testDefinition([
      factoryBean({
        id: "src/shared.ts#shared",
        source: testSource("shared"),
        definition,
      }),
    ]);
    const first = createApplicationContext(generated);
    const second = createApplicationContext(generated);
    await Promise.all([first.start(), second.start()]);

    expect(first.get(definition)).toBe(second.get(definition));
    expect(creations).toBe(2);
    await first.close();
    expect(disposals).toBe(1);
    await second.close();
    expect(disposals).toBe(2);
  });

  test("closing one Context does not redirect its handles into another Context", async () => {
    class Resource {
      constructor(readonly marker: number) {}
    }
    class Consumer {
      constructor(
        readonly proxy: Resource,
        readonly lazy: { get(): Resource },
      ) {}
    }
    let creations = 0;
    const resourceId = "src/resource.ts#Resource";
    const consumerId = "src/consumer.ts#Consumer";
    const consumer = classBean({
      id: consumerId,
      source: testSource("consumer"),
      target: Consumer,
      dependencies: [
        testDependency(0, resourceId, "cycle-proxy"),
        testDependency(1, resourceId, "explicit-lazy"),
      ],
      create: (resolver) => new Consumer(resolver.resolve(0), resolver.lazy(1)),
      hooks: {},
    });
    const resource = classBean({
      id: resourceId,
      source: testSource("resource"),
      target: Resource,
      dependencies: [],
      create: () => new Resource(++creations),
      hooks: {},
    });
    const generated = testDefinition([consumer, resource], {
      constructionOrder: [consumerId, resourceId],
    });
    const first = createApplicationContext(generated);
    const second = createApplicationContext(generated);
    await first.start();
    await second.start();
    const firstHandles = first.get(Consumer);
    const secondHandles = second.get(Consumer);

    await first.close();

    expect(() => firstHandles.proxy.marker).toThrow(ApplicationContextStateError);
    expect(() => firstHandles.lazy.get()).toThrow(ApplicationContextStateError);
    expect(secondHandles.proxy.marker).toBe(2);
    expect(secondHandles.lazy.get().marker).toBe(2);
    await second.close();
  });

  test("a context snapshots mutable generated arrays", async () => {
    class Resource {}
    const registration = classBean({
      id: "src/resource.ts#Resource",
      source: testSource("resource"),
      target: Resource,
      dependencies: [],
      create: () => new Resource(),
      hooks: {},
    });
    const registrations = [registration];
    const constructionOrder = [registration.id];
    const definition = {
      schemaVersion: 1 as const,
      registrations,
      plans: {
        constructionOrder,
        startActionOrder: [],
        cleanupActionOrder: [],
      },
    };
    const context = createApplicationContext(definition);

    registrations.length = 0;
    constructionOrder.length = 0;
    await context.start();

    expect(context.get(Resource)).toBeInstanceOf(Resource);
    await context.close();
  });
});
