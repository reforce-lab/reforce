import { describe, expect, test } from "vitest";
import { classBean, createApplicationContext } from "@/generated-runtime";
import {
  ApplicationContextStateError,
  BeanCreationError,
  EarlyBeanAccessError,
  InvalidGeneratedDefinitionError,
  UnregisteredBeanTargetError,
} from "@/index";
import { applicationStartError, rejection } from "../support/rejection";
import {
  testCollectionDependency,
  testDefinition,
  testDependency,
  testSource,
} from "../support/test-definition";

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

describe("collection resolution", () => {
  interface Named {
    name(): string;
  }

  class AlphaHandler implements Named {
    name(): string {
      return "alpha";
    }
  }
  class BetaHandler implements Named {
    name(): string {
      return "beta";
    }
  }
  class Registry {
    constructor(readonly handlers: readonly Named[]) {}
  }
  const alphaId = "src/alpha.ts#AlphaHandler";
  const betaId = "src/beta.ts#BetaHandler";
  const registryId = "src/registry.ts#Registry";

  function alphaRegistration() {
    return classBean({
      id: alphaId,
      source: testSource("alpha"),
      target: AlphaHandler,
      dependencies: [],
      create: () => new AlphaHandler(),
      hooks: {},
    });
  }

  function betaRegistration() {
    return classBean({
      id: betaId,
      source: testSource("beta"),
      target: BetaHandler,
      dependencies: [],
      create: () => new BetaHandler(),
      hooks: {},
    });
  }

  test("resolveAll injects members in the declared order as a frozen array", async () => {
    const registry = classBean({
      id: registryId,
      source: testSource("registry"),
      target: Registry,
      dependencies: [
        testCollectionDependency(0, [
          { targetId: betaId, mode: "eager" },
          { targetId: alphaId, mode: "eager" },
        ]),
      ],
      create: (resolver) => new Registry(resolver.resolveAll(0)),
      hooks: {},
    });
    const context = createApplicationContext(
      testDefinition([alphaRegistration(), betaRegistration(), registry], {
        constructionOrder: [alphaId, betaId, registryId],
      }),
    );
    await context.start();

    const handlers = context.get(Registry).handlers;

    expect(handlers.map((handler) => handler.name())).toEqual(["beta", "alpha"]);
    expect(Object.isFrozen(handlers)).toBe(true);
    expect(handlers[1]).toBe(context.get(AlphaHandler));
    await context.close();
  });

  test("resolveAll injects an empty frozen array when the collection has no members", async () => {
    const registry = classBean({
      id: registryId,
      source: testSource("registry"),
      target: Registry,
      dependencies: [testCollectionDependency(0, [])],
      create: (resolver) => new Registry(resolver.resolveAll(0)),
      hooks: {},
    });
    const context = createApplicationContext(testDefinition([registry]));
    await context.start();

    const handlers = context.get(Registry).handlers;

    expect(handlers).toEqual([]);
    expect(Object.isFrozen(handlers)).toBe(true);
    await context.close();
  });

  test("a cycle-proxy member forwards after its target is constructed", async () => {
    class Reentrant implements Named {
      constructor(readonly registry: Registry) {}
      name(): string {
        return "reentrant";
      }
    }
    const reentrantId = "src/reentrant.ts#Reentrant";
    const registry = classBean({
      id: registryId,
      source: testSource("registry"),
      target: Registry,
      dependencies: [testCollectionDependency(0, [{ targetId: reentrantId, mode: "cycle-proxy" }])],
      create: (resolver) => new Registry(resolver.resolveAll(0)),
      hooks: {},
    });
    const reentrant = classBean({
      id: reentrantId,
      source: testSource("reentrant"),
      target: Reentrant,
      dependencies: [testDependency(0, registryId, "eager")],
      create: (resolver) => new Reentrant(resolver.resolve(0)),
      hooks: {},
    });
    const context = createApplicationContext(
      testDefinition([registry, reentrant], {
        constructionOrder: [registryId, reentrantId],
      }),
    );
    await context.start();

    const handlers = context.get(Registry).handlers;

    expect(handlers[0]?.name()).toBe("reentrant");
    await context.close();
  });

  test("a cycle-proxy member rejects access before its target is constructed", async () => {
    class Eager {
      constructor(readonly names: readonly string[]) {}
    }
    const eagerId = "src/eager.ts#Eager";
    const registration = classBean({
      id: eagerId,
      source: testSource("eager"),
      target: Eager,
      dependencies: [testCollectionDependency(0, [{ targetId: alphaId, mode: "cycle-proxy" }])],
      create: (resolver) =>
        new Eager(resolver.resolveAll<Named>(0).map((handler) => handler.name())),
      hooks: {},
    });
    const context = createApplicationContext(
      testDefinition([registration, alphaRegistration()], {
        constructionOrder: [eagerId, alphaId],
      }),
    );

    const error = applicationStartError(await rejection(context.start()));

    expect(error.cause).toBeInstanceOf(BeanCreationError);
  });

  test("resolve rejects a collection edge", async () => {
    const registration = classBean({
      id: registryId,
      source: testSource("registry"),
      target: Registry,
      dependencies: [testCollectionDependency(0, [])],
      create: (resolver) => new Registry([resolver.resolve(0)]),
      hooks: {},
    });
    const context = createApplicationContext(testDefinition([registration]));

    const error = applicationStartError(await rejection(context.start()));

    expect(error.cause).toBeInstanceOf(InvalidGeneratedDefinitionError);
  });

  test("lazy rejects a collection edge", async () => {
    const registration = classBean({
      id: registryId,
      source: testSource("registry"),
      target: Registry,
      dependencies: [testCollectionDependency(0, [])],
      create: (resolver) => {
        resolver.lazy(0);
        return new Registry([]);
      },
      hooks: {},
    });
    const context = createApplicationContext(testDefinition([registration]));

    const error = applicationStartError(await rejection(context.start()));

    expect(error.cause).toBeInstanceOf(InvalidGeneratedDefinitionError);
  });

  test("resolveAll rejects a single-target edge", async () => {
    const registration = classBean({
      id: registryId,
      source: testSource("registry"),
      target: Registry,
      dependencies: [testDependency(0, alphaId, "eager")],
      create: (resolver) => new Registry(resolver.resolveAll(0)),
      hooks: {},
    });
    const context = createApplicationContext(
      testDefinition([alphaRegistration(), registration], {
        constructionOrder: [alphaId, registryId],
      }),
    );

    const error = applicationStartError(await rejection(context.start()));

    expect(error.cause).toBeInstanceOf(InvalidGeneratedDefinitionError);
  });
});
