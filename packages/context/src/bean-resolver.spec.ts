import { describe, expect, test } from "bun:test";
import { classBean, createApplicationContext } from "#internal/generated-runtime";
import {
  ApplicationContextStateError,
  ApplicationStartError,
  BeanCreationError,
  EarlyBeanAccessError,
  InvalidGeneratedDefinitionError,
  UnregisteredBeanTargetError,
} from "#internal/index";
import { testDefinition, testDependency, testSource } from "#test-support/test-definition";

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

describe("application context identity", () => {
  test("constructor injection and public lookup return one singleton", async () => {
    class Repository {}
    class Service {
      constructor(readonly repository: Repository) {}
    }
    const repositoryId = "src/repository.ts#Repository";
    const serviceId = "src/service.ts#Service";
    const repository = classBean({
      id: repositoryId,
      source: testSource("repository"),
      target: Repository,
      dependencies: [],
      create: () => new Repository(),
      hooks: {},
    });
    const service = classBean({
      id: serviceId,
      source: testSource("service"),
      target: Service,
      dependencies: [testDependency(0, repositoryId, "eager")],
      create: (resolver) => new Service(resolver.resolve(0)),
      hooks: {},
    });
    const context = createApplicationContext(
      testDefinition([repository, service], {
        constructionOrder: [repositoryId, serviceId],
      }),
    );

    await context.start();

    expect(context.get(Service).repository).toBe(context.get(Repository));
    await context.close();
  });

  test("lookup rejects a different class identity", async () => {
    class Service {}
    class DuplicateService {}
    const id = "src/service.ts#Service";
    const context = createApplicationContext(
      testDefinition([
        classBean({
          id,
          source: testSource("service"),
          target: Service,
          dependencies: [],
          create: () => new Service(),
          hooks: {},
        }),
      ]),
    );
    await context.start();

    const lookup = () => context.get(DuplicateService);

    expect(lookup).toThrow(UnregisteredBeanTargetError);
    await context.close();
  });

  test("lookup fails synchronously before startup", () => {
    class Service {}
    const context = createApplicationContext(
      testDefinition([
        classBean({
          id: "src/service.ts#Service",
          source: testSource("service"),
          target: Service,
          dependencies: [],
          create: () => new Service(),
          hooks: {},
        }),
      ]),
    );

    const lookup = () => context.get(Service);

    expect(lookup).toThrow(ApplicationContextStateError);
  });
});

describe("dependency resolution", () => {
  test("a cycle proxy forwards after its target is constructed", async () => {
    class A {
      readonly value = "ready";
      constructor(readonly b: B) {}
    }
    class B {
      constructor(readonly a: A) {}
    }
    const aId = "src/a.ts#A";
    const bId = "src/b.ts#B";
    const b = classBean({
      id: bId,
      source: testSource("b"),
      target: B,
      dependencies: [testDependency(0, aId, "cycle-proxy")],
      create: (resolver) => new B(resolver.resolve(0)),
      hooks: {},
    });
    const a = classBean({
      id: aId,
      source: testSource("a"),
      target: A,
      dependencies: [testDependency(0, bId, "eager")],
      create: (resolver) => new A(resolver.resolve(0)),
      hooks: {},
    });
    const context = createApplicationContext(
      testDefinition([a, b], { constructionOrder: [bId, aId] }),
    );

    await context.start();

    expect(context.get(B).a.value).toBe("ready");
    await context.close();
  });

  test("repeated cycle edges share one stable proxy", async () => {
    class A {}
    class B {
      constructor(
        readonly first: A,
        readonly second: A,
      ) {}
    }
    const aId = "src/a.ts#A";
    const bId = "src/b.ts#B";
    const b = classBean({
      id: bId,
      source: testSource("b"),
      target: B,
      dependencies: [testDependency(0, aId, "cycle-proxy"), testDependency(1, aId, "cycle-proxy")],
      create: (resolver) => new B(resolver.resolve(0), resolver.resolve(1)),
      hooks: {},
    });
    const a = classBean({
      id: aId,
      source: testSource("a"),
      target: A,
      dependencies: [],
      create: () => new A(),
      hooks: {},
    });
    const context = createApplicationContext(
      testDefinition([a, b], { constructionOrder: [bId, aId] }),
    );
    await context.start();

    const instance = context.get(B);

    expect(instance.first).toBe(instance.second);
    await context.close();
  });

  test("a cycle proxy expires when its Context closes", async () => {
    class A {
      readonly value = "ready";
    }
    class B {
      constructor(readonly a: A) {}
    }
    const aId = "src/a.ts#A";
    const bId = "src/b.ts#B";
    const b = classBean({
      id: bId,
      source: testSource("b"),
      target: B,
      dependencies: [testDependency(0, aId, "cycle-proxy")],
      create: (resolver) => new B(resolver.resolve(0)),
      hooks: {},
    });
    const a = classBean({
      id: aId,
      source: testSource("a"),
      target: A,
      dependencies: [],
      create: () => new A(),
      hooks: {},
    });
    const context = createApplicationContext(
      testDefinition([b, a], { constructionOrder: [bId, aId] }),
    );
    await context.start();
    const proxy = context.get(B).a;

    await context.close();

    expect(() => proxy.value).toThrow(ApplicationContextStateError);
  });

  test("accessing a cycle proxy during construction reports the full path", async () => {
    class A {
      readonly value = "unavailable";
    }
    class B {}
    const aId = "src/a.ts#A";
    const bId = "src/b.ts#B";
    const b = classBean({
      id: bId,
      source: testSource("b"),
      target: B,
      dependencies: [testDependency(0, aId, "cycle-proxy")],
      create: (resolver) => {
        const a = resolver.resolve<A>(0);
        a.value;
        return new B();
      },
      hooks: {},
    });
    const a = classBean({
      id: aId,
      source: testSource("a"),
      target: A,
      dependencies: [testDependency(0, bId, "eager")],
      create: (resolver) => {
        resolver.resolve(0);
        return new A();
      },
      hooks: {},
    });
    const context = createApplicationContext(
      testDefinition([a, b], { constructionOrder: [bId, aId] }),
    );

    const startError = applicationStartError(await rejection(context.start()));

    expect(startError.cause).toBeInstanceOf(BeanCreationError);
    if (!(startError.cause instanceof BeanCreationError)) {
      throw startError.cause;
    }
    expect(startError.cause.cause).toBeInstanceOf(EarlyBeanAccessError);
    if (!(startError.cause.cause instanceof EarlyBeanAccessError)) {
      throw startError.cause.cause;
    }
    expect(startError.cause.cause.constructionPath).toEqual([bId, aId]);
  });

  test("a Lazy handle can construct an unresolved target during startup", async () => {
    class Dependency {}
    class Consumer {
      constructor(
        readonly dependency: Dependency,
        readonly lazy: { get(): Dependency },
      ) {}
    }
    const dependencyId = "src/dependency.ts#Dependency";
    const consumerId = "src/consumer.ts#Consumer";
    let creations = 0;
    const dependency = classBean({
      id: dependencyId,
      source: testSource("dependency"),
      target: Dependency,
      dependencies: [],
      create: () => {
        creations += 1;
        return new Dependency();
      },
      hooks: {},
    });
    const consumer = classBean({
      id: consumerId,
      source: testSource("consumer"),
      target: Consumer,
      dependencies: [testDependency(0, dependencyId, "explicit-lazy")],
      create: (resolver) => {
        const lazy = resolver.lazy<Dependency>(0);
        return new Consumer(lazy.get(), lazy);
      },
      hooks: {},
    });
    const context = createApplicationContext(
      testDefinition([consumer, dependency], {
        constructionOrder: [consumerId, dependencyId],
      }),
    );

    await context.start();

    const instance = context.get(Consumer);
    expect(creations).toBe(1);
    expect(instance.dependency).toBe(context.get(Dependency));
    expect(instance.lazy.get()).toBe(context.get(Dependency));
    await context.close();
  });

  test("a Lazy handle rejects access to its constructing target", async () => {
    class Resource {}
    const id = "src/resource.ts#Resource";
    const registration = classBean({
      id,
      source: testSource("resource"),
      target: Resource,
      dependencies: [testDependency(0, id, "explicit-lazy")],
      create: (resolver) => {
        resolver.lazy<Resource>(0).get();
        return new Resource();
      },
      hooks: {},
    });
    const context = createApplicationContext(testDefinition([registration]));

    const error = applicationStartError(await rejection(context.start()));

    expect(error.cause).toBeInstanceOf(BeanCreationError);
    if (!(error.cause instanceof BeanCreationError)) {
      throw error.cause;
    }
    expect(error.cause.cause).toBeInstanceOf(EarlyBeanAccessError);
  });

  test("Lazy remains usable during ordered cleanup and expires afterward", async () => {
    class Dependency {}
    class Consumer {
      constructor(readonly lazy: { get(): Dependency }) {}
    }
    const dependencyId = "src/dependency.ts#Dependency";
    const consumerId = "src/consumer.ts#Consumer";
    let observed: Dependency | undefined;
    const dependency = classBean({
      id: dependencyId,
      source: testSource("dependency"),
      target: Dependency,
      dependencies: [],
      create: () => new Dependency(),
      hooks: {},
    });
    const consumer = classBean({
      id: consumerId,
      source: testSource("consumer"),
      target: Consumer,
      dependencies: [testDependency(0, dependencyId, "explicit-lazy")],
      create: (resolver) => new Consumer(resolver.lazy(0)),
      hooks: {
        close: (instance) => {
          observed = instance.lazy.get();
        },
      },
    });
    const context = createApplicationContext(
      testDefinition([dependency, consumer], {
        constructionOrder: [dependencyId, consumerId],
        cleanupActionOrder: [consumerId],
      }),
    );
    await context.start();
    const lazy = context.get(Consumer).lazy;

    await context.close();

    expect(observed).toBeInstanceOf(Dependency);
    expect(() => lazy.get()).toThrow(ApplicationContextStateError);
  });

  test("a generated resolver rejects an undeclared index", async () => {
    class Service {}
    const id = "src/service.ts#Service";
    const context = createApplicationContext(
      testDefinition([
        classBean({
          id,
          source: testSource("service"),
          target: Service,
          dependencies: [],
          create: (resolver) => {
            resolver.resolve(1);
            return new Service();
          },
          hooks: {},
        }),
      ]),
    );

    const error = applicationStartError(await rejection(context.start()));

    expect(error.cause).toBeInstanceOf(InvalidGeneratedDefinitionError);
  });
});
