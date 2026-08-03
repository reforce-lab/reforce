import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { classBean, createApplicationContext, factoryBean } from "@/generated-runtime";
import {
  ApplicationCleanupError,
  ApplicationContextStateError,
  ApplicationStartError,
  BeanCreationError,
  BeanLifecycleError,
  defineBean,
} from "@/index";
import { testDefinition, testSource } from "../support/test-definition";

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

function applicationStartError(error: Error): ApplicationStartError {
  expect(error).toBeInstanceOf(ApplicationStartError);
  if (!(error instanceof ApplicationStartError)) {
    throw error;
  }
  return error;
}

function applicationCleanupError(error: Error): ApplicationCleanupError {
  expect(error).toBeInstanceOf(ApplicationCleanupError);
  if (!(error instanceof ApplicationCleanupError)) {
    throw error;
  }
  return error;
}

describe("startup and shutdown coordination", () => {
  test("concurrent shutdown callers share one result and one cleanup", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 32 }), async (callCount) => {
        class Resource {}
        let cleanups = 0;
        const registration = classBean({
          id: "src/resource.ts#Resource",
          source: testSource("resource"),
          target: Resource,
          dependencies: [],
          create: () => new Resource(),
          hooks: {
            close: async () => {
              await Promise.resolve();
              cleanups += 1;
            },
          },
        });
        const context = createApplicationContext(testDefinition([registration]));
        await context.start();

        const promises = Array.from({ length: callCount }, () => context.close());

        expect(new Set(promises).size).toBe(1);
        await Promise.all(promises);
        expect(cleanups).toBe(1);
      }),
      { numRuns: 40 },
    );
  });

  test("a second start rejects without throwing synchronously", async () => {
    const context = createApplicationContext(testDefinition([]));
    const first = context.start();
    let second: Promise<void> | undefined;

    expect(() => {
      second = context.start();
    }).not.toThrow();
    await first;
    await expect(second).rejects.toBeInstanceOf(ApplicationContextStateError);
    await context.close();
  });

  test("closing before startup permanently rejects startup", async () => {
    const context = createApplicationContext(testDefinition([]));

    const firstClose = context.close();
    const secondClose = context.close();
    await firstClose;

    expect(secondClose).toBe(firstClose);
    await expect(context.start()).rejects.toBeInstanceOf(ApplicationContextStateError);
  });

  test("shutdown requested during startup never exposes running lookup", async () => {
    class Resource {}
    const gate = Promise.withResolvers<void>();
    let cleanup = 0;
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
            start: () => gate.promise,
            close: () => {
              cleanup += 1;
            },
          },
        }),
      ]),
    );
    const start = context.start();
    const close = context.close();

    gate.resolve();
    await start;

    expect(() => context.get(Resource)).toThrow(ApplicationContextStateError);
    await close;
    expect(cleanup).toBe(1);
  });

  test("a start hook can request the same single-flight shutdown", async () => {
    class Resource {}
    let context: ReturnType<typeof createApplicationContext> | undefined;
    let closeFromHook: Promise<void> | undefined;
    let cleanups = 0;
    const registration = classBean({
      id: "src/resource.ts#Resource",
      source: testSource("resource"),
      target: Resource,
      dependencies: [],
      create: () => new Resource(),
      hooks: {
        start: () => {
          if (!context) {
            throw new Error("Context was not assigned before startup.");
          }
          closeFromHook = context.close();
        },
        close: () => {
          cleanups += 1;
        },
      },
    });
    context = createApplicationContext(testDefinition([registration]));

    await context.start();
    if (!closeFromHook) {
      throw new Error("Start hook did not request shutdown.");
    }

    expect(context.close()).toBe(closeFromHook);
    await closeFromHook;
    expect(cleanups).toBe(1);
  });

  test("startup keeps its original error when rollback also fails", async () => {
    class Resource {}
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
            start: () => Promise.reject(new Error("startup")),
            close: () => Promise.reject(new Error("cleanup")),
          },
        }),
      ]),
    );

    const startError = applicationStartError(await rejection(context.start()));
    const closeError = applicationCleanupError(await rejection(context.close()));

    expect(startError.cause).toBeInstanceOf(BeanLifecycleError);
    if (!(startError.cause instanceof BeanLifecycleError)) {
      throw startError.cause;
    }
    if (!(startError.cause.cause instanceof Error)) {
      throw startError.cause.cause;
    }
    expect(startError.cause.cause.message).toBe("startup");
    expect(startError.errors).toHaveLength(1);
    expect(closeError.errors).toEqual(startError.errors);
  });

  test("a callable factory result remains a valid Bean instance", async () => {
    const callable = () => "ready";
    const definition = defineBean({ create: () => callable });
    const context = createApplicationContext(
      testDefinition([
        factoryBean({
          id: "src/callable.ts#callable",
          source: testSource("callable"),
          definition,
        }),
      ]),
    );

    await context.start();

    expect(context.get(definition)()).toBe("ready");
    await context.close();
  });

  test("a Promise factory result fails before a disposer is registered", async () => {
    let disposals = 0;
    const definition = defineBean({
      create: async () => ({}),
      dispose: () => {
        disposals += 1;
      },
    });
    const context = createApplicationContext(
      testDefinition([
        factoryBean({
          id: "src/resource.ts#resource",
          source: testSource("resource"),
          definition,
        }),
      ]),
    );

    const error = applicationStartError(await rejection(context.start()));

    expect(error.cause).toBeInstanceOf(BeanCreationError);
    expect(disposals).toBe(0);
  });

  test("a thenable factory result fails before a disposer is registered", async () => {
    let disposals = 0;
    const definition = defineBean({
      create: () => ({
        // biome-ignore lint/suspicious/noThenProperty: The runtime must reject arbitrary thenables, not only native Promise instances.
        then: () => undefined,
      }),
      dispose: () => {
        disposals += 1;
      },
    });
    const context = createApplicationContext(
      testDefinition([
        factoryBean({
          id: "src/thenable.ts#thenable",
          source: testSource("thenable"),
          definition,
        }),
      ]),
    );

    const error = applicationStartError(await rejection(context.start()));

    expect(error.cause).toBeInstanceOf(BeanCreationError);
    expect(disposals).toBe(0);
  });
});
