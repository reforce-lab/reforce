import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { classBean, createApplicationContext, factoryBean } from "@/generated-runtime";
import { ApplicationCleanupError, ApplicationStartError, defineBean } from "@/index";
import { testDefinition, testDependency, testSource } from "./support/test-definition";

async function rejection(promise: Promise<unknown>): Promise<Error> {
  let reason: unknown;
  try {
    await promise;
  } catch (error) {
    reason = error;
  }
  if (!(reason instanceof Error)) {
    throw new Error("Expected the Promise to reject with an Error.");
  }
  return reason;
}

function applicationCleanupError(error: Error): ApplicationCleanupError {
  expect(error).toBeInstanceOf(ApplicationCleanupError);
  if (!(error instanceof ApplicationCleanupError)) {
    throw error;
  }
  return error;
}

describe("lifecycle execution", () => {
  test("startup and cleanup consume their generated order forward", async () => {
    class Dependency {}
    class Consumer {}
    const dependencyId = "src/dependency.ts#Dependency";
    const consumerId = "src/consumer.ts#Consumer";
    const actions: string[] = [];
    const dependency = classBean({
      id: dependencyId,
      source: testSource("dependency"),
      target: Dependency,
      dependencies: [],
      create: () => new Dependency(),
      hooks: {
        start: () => {
          actions.push("start dependency");
        },
        close: () => {
          actions.push("close dependency");
        },
      },
    });
    const consumer = classBean({
      id: consumerId,
      source: testSource("consumer"),
      target: Consumer,
      dependencies: [testDependency(0, dependencyId, "eager")],
      create: (resolver) => {
        resolver.resolve(0);
        return new Consumer();
      },
      hooks: {
        start: () => {
          actions.push("start consumer");
        },
        close: () => {
          actions.push("close consumer");
        },
      },
    });
    const context = createApplicationContext(
      testDefinition([dependency, consumer], {
        constructionOrder: [dependencyId, consumerId],
        startActionOrder: [dependencyId, consumerId],
        cleanupActionOrder: [consumerId, dependencyId],
      }),
    );

    await context.start();
    await context.close();

    expect(actions).toEqual([
      "start dependency",
      "start consumer",
      "close consumer",
      "close dependency",
    ]);
  });

  test("all close calls return one Promise and consume cleanup once", async () => {
    class Resource {}
    let cleanups = 0;
    const id = "src/resource.ts#Resource";
    const context = createApplicationContext(
      testDefinition([
        classBean({
          id,
          source: testSource("resource"),
          target: Resource,
          dependencies: [],
          create: () => new Resource(),
          hooks: {
            close: () => {
              cleanups += 1;
            },
          },
        }),
      ]),
    );
    await context.start();

    const first = context.close();
    const second = context.close();

    expect(first).toBe(second);
    await first;
    expect(context.close()).toBe(first);
    expect(cleanups).toBe(1);
  });

  test("cleanup errors retain generated execution order", async () => {
    class First {}
    class Second {}
    const firstId = "src/first.ts#First";
    const secondId = "src/second.ts#Second";
    const first = classBean({
      id: firstId,
      source: testSource("first"),
      target: First,
      dependencies: [],
      create: () => new First(),
      hooks: { close: () => Promise.reject(new Error("first")) },
    });
    const second = classBean({
      id: secondId,
      source: testSource("second"),
      target: Second,
      dependencies: [],
      create: () => new Second(),
      hooks: { close: () => Promise.reject(new Error("second")) },
    });
    const context = createApplicationContext(
      testDefinition([first, second], {
        cleanupActionOrder: [secondId, firstId],
      }),
    );
    await context.start();

    const error = applicationCleanupError(await rejection(context.close()));

    expect(error.errors.map((item) => item.beanId)).toEqual([secondId, firstId]);
  });

  test("a factory uses only its explicit disposer", async () => {
    let duckClose = 0;
    let dispose = 0;
    const definition = defineBean({
      create: () => ({ onContextClose: () => duckClose++ }),
      dispose: () => {
        dispose += 1;
      },
    });
    const registration = factoryBean({
      id: "src/resource.ts#resource",
      source: testSource("resource"),
      definition,
    });
    const context = createApplicationContext(testDefinition([registration]));
    await context.start();

    await context.close();

    expect(dispose).toBe(1);
    expect(duckClose).toBe(0);
  });

  test("two registrations dispose a shared object independently", async () => {
    const shared = {};
    let disposals = 0;
    const firstDefinition = defineBean({
      create: () => shared,
      dispose: () => {
        disposals += 1;
      },
    });
    const secondDefinition = defineBean({
      create: () => shared,
      dispose: () => {
        disposals += 1;
      },
    });
    const first = factoryBean({
      id: "src/first.ts#first",
      source: testSource("first"),
      definition: firstDefinition,
    });
    const second = factoryBean({
      id: "src/second.ts#second",
      source: testSource("second"),
      definition: secondDefinition,
    });
    const context = createApplicationContext(testDefinition([first, second]));
    await context.start();

    await context.close();

    expect(disposals).toBe(2);
  });
});

describe("lifecycle properties", () => {
  test("every successfully created resource is cleaned once after a construction failure", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 5 }), async (failureIndex) => {
        const cleanupCounts = Array.from({ length: 6 }, () => 0);
        const registrations = cleanupCounts.map((_, index) => {
          const Resource = class {
            readonly index = index;
          };
          return classBean({
            id: `src/resource-${index}.ts#Resource${index}`,
            source: testSource(`resource-${index}`),
            target: Resource,
            dependencies: [],
            create: () => {
              if (index === failureIndex) {
                throw new Error(`failure ${index}`);
              }
              return new Resource();
            },
            hooks: {
              close: () => {
                cleanupCounts[index] = (cleanupCounts[index] ?? 0) + 1;
              },
            },
          });
        });
        const context = createApplicationContext(
          testDefinition(registrations, {
            cleanupActionOrder: registrations.map((item) => item.id).reverse(),
          }),
        );

        const error = await context.start().catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(ApplicationStartError);
        expect(cleanupCounts).toEqual(
          cleanupCounts.map((_, index) => (index < failureIndex ? 1 : 0)),
        );
      }),
      { numRuns: 40 },
    );
  });

  test("registration input order does not replace the generated lifecycle order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 0, max: 3 }), {
          minLength: 4,
          maxLength: 4,
        }),
        async (inputOrder) => {
          const actions: number[] = [];
          const registrations = Array.from({ length: 4 }, (_, index) => {
            const Resource = class {};
            return classBean({
              id: `src/resource-${index}.ts#Resource${index}`,
              source: testSource(`resource-${index}`),
              target: Resource,
              dependencies: [],
              create: () => new Resource(),
              hooks: {
                start: () => {
                  actions.push(index);
                },
              },
            });
          });
          const shuffled = inputOrder.map((index) => {
            const registration = registrations[index];
            if (!registration) {
              throw new Error(`Missing generated registration ${index}.`);
            }
            return registration;
          });
          const plan = registrations.map((registration) => registration.id);
          const context = createApplicationContext(
            testDefinition(shuffled, {
              constructionOrder: plan,
              startActionOrder: plan,
            }),
          );

          await context.start();

          expect(actions).toEqual([0, 1, 2, 3]);
          await context.close();
        },
      ),
      { numRuns: 40 },
    );
  });
});
