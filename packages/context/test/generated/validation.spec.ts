import { describe, expect, test } from "vitest";
import type {
  GeneratedBeanRegistration,
  GeneratedConfigBinding,
  GeneratedDependency,
} from "@/generated/contracts";
import { snapshotApplicationDefinition } from "@/generated/validation";
import { classBean, configBean, createApplicationContext } from "@/generated-runtime";
import { defineBean, InvalidGeneratedDefinitionError } from "@/index";
import {
  testCollectionDependency,
  testDefinition,
  testDependency,
  testSource,
} from "../support/test-definition";

describe("generated definition validation", () => {
  test("a Bean ID must contain a relative path and direct export", () => {
    class Resource {}
    const definition = testDefinition([
      {
        kind: "class",
        id: "../resource.ts#",
        source: testSource("resource"),
        scope: "singleton",
        target: Resource,
        dependencies: [],
        create: () => new Resource(),
        hooks: {},
      },
    ]);

    const create = () => createApplicationContext(definition);

    expect(create).toThrow(InvalidGeneratedDefinitionError);
  });

  test("portable case collisions are rejected on every host", () => {
    class UpperResource {}
    class LowerResource {}
    const upper = classBean({
      id: "src/Resource.ts#Resource",
      source: testSource("upper-resource"),
      target: UpperResource,
      dependencies: [],
      create: () => new UpperResource(),
      hooks: {},
    });
    const lower = classBean({
      id: "src/resource.ts#resource",
      source: testSource("lower-resource"),
      target: LowerResource,
      dependencies: [],
      create: () => new LowerResource(),
      hooks: {},
    });

    const create = () => createApplicationContext(testDefinition([upper, lower]));

    expect(create).toThrow("portable case collision");
  });

  test("duplicate class target identity is rejected", () => {
    class Resource {}
    const first = classBean({
      id: "src/first.ts#Resource",
      source: testSource("first"),
      target: Resource,
      dependencies: [],
      create: () => new Resource(),
      hooks: {},
    });
    const second = classBean({
      id: "src/second.ts#Resource",
      source: testSource("second"),
      target: Resource,
      dependencies: [],
      create: () => new Resource(),
      hooks: {},
    });

    const create = () => createApplicationContext(testDefinition([first, second]));

    expect(create).toThrow("class target");
  });

  test("an edge cannot reference an unknown Bean", () => {
    class Resource {}
    const registration = classBean({
      id: "src/resource.ts#Resource",
      source: testSource("resource"),
      target: Resource,
      dependencies: [testDependency(0, "src/missing.ts#Missing", "cycle-proxy")],
      create: (resolver) => {
        resolver.resolve(0);
        return new Resource();
      },
      hooks: {},
    });

    const create = () => createApplicationContext(testDefinition([registration]));

    expect(create).toThrow("unknown Bean");
  });

  test("eager dependencies must precede their consumer", () => {
    class Dependency {}
    class Consumer {}
    const dependencyId = "src/dependency.ts#Dependency";
    const consumerId = "src/consumer.ts#Consumer";
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
      dependencies: [testDependency(0, dependencyId, "eager")],
      create: (resolver) => {
        resolver.resolve(0);
        return new Consumer();
      },
      hooks: {},
    });
    const definition = testDefinition([consumer, dependency], {
      constructionOrder: [consumerId, dependencyId],
    });

    const create = () => createApplicationContext(definition);

    expect(create).toThrow("must place eager dependency");
  });

  test("action plans must exactly cover declared hooks", () => {
    class Resource {}
    const registration = classBean({
      id: "src/resource.ts#Resource",
      source: testSource("resource"),
      target: Resource,
      dependencies: [],
      create: () => new Resource(),
      hooks: { close: () => undefined },
    });
    const definition = testDefinition([registration], {
      cleanupActionOrder: [],
    });

    const create = () => createApplicationContext(definition);

    expect(create).toThrow("does not exactly cover");
  });

  test("unknown schema fields are not ignored", () => {
    const definition = {
      ...testDefinition([]),
      fallback: true,
    };

    const create = () => Reflect.apply(createApplicationContext, undefined, [definition]);

    expect(create).toThrow("unknown field");
  });

  test("a class helper does not execute user code", () => {
    class Resource {}
    let creations = 0;

    classBean({
      id: "src/resource.ts#Resource",
      source: testSource("resource"),
      target: Resource,
      dependencies: [],
      create: () => {
        creations += 1;
        return new Resource();
      },
      hooks: {},
    });

    expect(creations).toBe(0);
  });
});

describe("generated definition config validation", () => {
  class ServerConfig {
    constructor(readonly values: object) {}
  }
  class Consumer {}
  const serverConfigId = "src/server-config.ts#ServerConfig";
  const consumerId = "src/consumer.ts#Consumer";

  function serverConfigRegistration() {
    return configBean({
      id: serverConfigId,
      source: testSource("server-config"),
      target: ServerConfig,
    });
  }

  function noopBinding(): GeneratedConfigBinding {
    return {
      bind: () => Promise.resolve({ status: "bound", instances: new Map<string, object>() }),
    };
  }

  function consumerRegistration(dependencies: readonly GeneratedDependency[] = []) {
    return classBean({
      id: consumerId,
      source: testSource("consumer"),
      target: Consumer,
      dependencies,
      create: () => new Consumer(),
      hooks: {},
    });
  }

  function expectInvalid(definition: unknown, fragment: string): void {
    const create = () => Reflect.apply(createApplicationContext, undefined, [definition]);
    expect(create).toThrow(InvalidGeneratedDefinitionError);
    expect(create).toThrow(fragment);
  }

  test("accepts a config with an eager dependency onto it and freezes the snapshot", () => {
    const definition = testDefinition(
      [consumerRegistration([testDependency(0, serverConfigId, "eager")])],
      { configs: [serverConfigRegistration()], configBinding: noopBinding() },
    );

    const snapshot = snapshotApplicationDefinition(definition);

    expect(snapshot.schemaVersion).toBe(5);
    expect(Object.isFrozen(snapshot.configs)).toBe(true);
    expect(Object.isFrozen(snapshot.configs[0])).toBe(true);
    expect(snapshot.configs[0]?.target).toBe(ServerConfig);
  });

  // v4 随 RFC 0011 L2（#242）退役：合成的 logger bean 是「一个运行导出承载 N 个 bean 身份、
  // 且不提供任何契约」的新形态，按 v4 读取的一方会把它判成非法产物。
  test("rejects the retired schema versions 1 through 4", () => {
    const { configs: _configs, ...rest } = testDefinition([consumerRegistration()]);

    for (const retired of [1, 2, 3, 4]) {
      expectInvalid({ ...rest, configs: [], schemaVersion: retired }, "schemaVersion must be 5");
    }
  });

  test("rejects a definition without the configs field", () => {
    const { configs: _configs, ...withoutConfigs } = testDefinition([consumerRegistration()]);

    expectInvalid(withoutConfigs, "configs");
  });

  test("rejects a non-empty configs list without a configBinding", () => {
    const definition = testDefinition([], { configs: [serverConfigRegistration()] });

    expectInvalid(definition, "configBinding");
  });

  test("rejects a configBinding alongside an empty configs list", () => {
    const definition = testDefinition([consumerRegistration()], {
      configBinding: noopBinding(),
    });

    expectInvalid(definition, "configBinding");
  });

  test("rejects a configBinding whose bind is not a function", () => {
    const definition = testDefinition([], {
      configs: [serverConfigRegistration()],
      configBinding: { bind: "not-a-function" } as unknown as GeneratedConfigBinding,
    });

    expectInvalid(definition, "bind");
  });

  test("rejects a config registration carrying an unknown field", () => {
    const tampered = { ...serverConfigRegistration(), prefix: "server" };
    const definition = testDefinition([], {
      configs: [tampered as unknown as ReturnType<typeof serverConfigRegistration>],
      configBinding: noopBinding(),
    });

    expectInvalid(definition, 'unknown field "prefix"');
  });

  test("rejects a config id colliding with a registration id", () => {
    const definition = testDefinition([consumerRegistration()], {
      configs: [
        configBean({
          id: consumerId,
          source: testSource("server-config"),
          target: ServerConfig,
        }),
      ],
      configBinding: noopBinding(),
    });

    expectInvalid(definition, "duplicated");
  });

  test("rejects a config target shared with a class registration", () => {
    const definition = testDefinition(
      [
        classBean({
          id: "src/other.ts#Other",
          source: testSource("other"),
          target: ServerConfig,
          dependencies: [],
          create: () => new ServerConfig({}),
          hooks: {},
        }),
      ],
      { configs: [serverConfigRegistration()], configBinding: noopBinding() },
    );

    expectInvalid(definition, "duplicated");
  });

  test("rejects a non-eager dependency onto a config", () => {
    for (const mode of ["cycle-proxy", "explicit-lazy"] as const) {
      const definition = testDefinition(
        [consumerRegistration([testDependency(0, serverConfigId, mode)])],
        { configs: [serverConfigRegistration()], configBinding: noopBinding() },
      );

      expectInvalid(definition, "eager");
    }
  });

  test("rejects a construction plan that lists a config", () => {
    const definition = testDefinition([consumerRegistration()], {
      configs: [serverConfigRegistration()],
      configBinding: noopBinding(),
      constructionOrder: [serverConfigId, consumerId],
    });

    expectInvalid(definition, "unknown Bean ID");
  });
});

describe("generated definition collection edges (schema v3)", () => {
  class Handler {}
  class OtherHandler {}
  class Registry {}
  const handlerId = "src/handler.ts#Handler";
  const otherHandlerId = "src/other-handler.ts#OtherHandler";
  const registryId = "src/registry.ts#Registry";

  function handlerRegistration() {
    return classBean({
      id: handlerId,
      source: testSource("handler"),
      target: Handler,
      dependencies: [],
      create: () => new Handler(),
      hooks: {},
    });
  }

  function otherHandlerRegistration() {
    return classBean({
      id: otherHandlerId,
      source: testSource("other-handler"),
      target: OtherHandler,
      dependencies: [],
      create: () => new OtherHandler(),
      hooks: {},
    });
  }

  function registryRegistration(dependencies: readonly GeneratedDependency[]) {
    return classBean({
      id: registryId,
      source: testSource("registry"),
      target: Registry,
      dependencies,
      create: () => new Registry(),
      hooks: {},
    });
  }

  // 负向用例的坏边不能经 classBean 构造——注册助手当场校验，异常会落在被断言的调用之外。
  function rawRegistryRegistration(dependencies: readonly unknown[]): GeneratedBeanRegistration {
    return {
      kind: "class",
      id: registryId,
      source: testSource("registry"),
      scope: "singleton",
      target: Registry,
      dependencies: dependencies as readonly GeneratedDependency[], // 坏形状即测试输入，交给运行时校验裁决
      create: () => new Registry(),
      hooks: {},
    };
  }

  function expectInvalid(definition: unknown, fragment: string): void {
    const create = () => Reflect.apply(createApplicationContext, undefined, [definition]);
    expect(create).toThrow(InvalidGeneratedDefinitionError);
    expect(create).toThrow(fragment);
  }

  test("accepts a collection edge and freezes its member list in the snapshot", () => {
    const definition = testDefinition(
      [
        handlerRegistration(),
        otherHandlerRegistration(),
        registryRegistration([
          testCollectionDependency(0, [
            { targetId: handlerId, mode: "eager" },
            { targetId: otherHandlerId, mode: "eager" },
          ]),
        ]),
      ],
      { constructionOrder: [handlerId, otherHandlerId, registryId] },
    );

    const snapshot = snapshotApplicationDefinition(definition);

    const dependency = snapshot.registrations[2]?.dependencies[0];
    if (dependency?.mode !== "collection") {
      throw new Error("Expected a collection dependency in the snapshot.");
    }
    expect(Object.isFrozen(dependency.members)).toBe(true);
    expect(dependency.members).toEqual([
      { targetId: handlerId, mode: "eager" },
      { targetId: otherHandlerId, mode: "eager" },
    ]);
  });

  test("accepts an empty member list", () => {
    const definition = testDefinition([registryRegistration([testCollectionDependency(0, [])])]);

    const snapshot = snapshotApplicationDefinition(definition);

    const dependency = snapshot.registrations[0]?.dependencies[0];
    if (dependency?.mode !== "collection") {
      throw new Error("Expected a collection dependency in the snapshot.");
    }
    expect(dependency.members).toEqual([]);
  });

  test("a snapshot keeps its own copy of a collection member list", () => {
    const members = [{ targetId: handlerId, mode: "eager" as const }];
    const definition = testDefinition(
      [handlerRegistration(), registryRegistration([testCollectionDependency(0, members)])],
      { constructionOrder: [handlerId, registryId] },
    );

    const snapshot = snapshotApplicationDefinition(definition);
    members.push({ targetId: handlerId, mode: "eager" });

    const dependency = snapshot.registrations[1]?.dependencies[0];
    if (dependency?.mode !== "collection") {
      throw new Error("Expected a collection dependency in the snapshot.");
    }
    expect(dependency.members).toHaveLength(1);
  });

  test("rejects a collection edge that also carries a single-target field", () => {
    const tampered = { ...testCollectionDependency(0, []), targetId: handlerId };
    const definition = testDefinition([handlerRegistration(), rawRegistryRegistration([tampered])]);

    expectInvalid(definition, 'unknown field "targetId"');
  });

  test("rejects a single edge that carries a member list", () => {
    const tampered = { ...testDependency(0, handlerId, "eager"), members: [] };
    const definition = testDefinition(
      [handlerRegistration(), rawRegistryRegistration([tampered])],
      { constructionOrder: [handlerId, registryId] },
    );

    expectInvalid(definition, 'unknown field "members"');
  });

  test("rejects an explicit-lazy member mode", () => {
    const definition = testDefinition([
      handlerRegistration(),
      rawRegistryRegistration([
        {
          ...testCollectionDependency(0, []),
          members: [{ targetId: handlerId, mode: "explicit-lazy" }],
        },
      ]),
    ]);

    expectInvalid(definition, "mode");
  });

  test("rejects duplicate member targets", () => {
    const definition = testDefinition([
      handlerRegistration(),
      rawRegistryRegistration([
        testCollectionDependency(0, [
          { targetId: handlerId, mode: "eager" },
          { targetId: handlerId, mode: "eager" },
        ]),
      ]),
    ]);

    expectInvalid(definition, "duplicate");
  });

  test("rejects a member referencing an unknown Bean", () => {
    const definition = testDefinition([
      rawRegistryRegistration([
        testCollectionDependency(0, [{ targetId: "src/missing.ts#Missing", mode: "eager" }]),
      ]),
    ]);

    expectInvalid(definition, "unknown Bean");
  });

  test("eager collection members must precede their consumer", () => {
    const definition = testDefinition(
      [
        handlerRegistration(),
        registryRegistration([
          testCollectionDependency(0, [{ targetId: handlerId, mode: "eager" }]),
        ]),
      ],
      { constructionOrder: [registryId, handlerId] },
    );

    expectInvalid(definition, "must place eager dependency");
  });
});

describe("generated definition request scope (schema v4)", () => {
  class Clock {}
  class RootContext {}
  class Holder {}
  const clockId = "src/clock.ts#Clock";
  const rootId = "src/root.ts#RootContext";
  const holderId = "src/holder.ts#Holder";

  function clockRegistration(dependencies: readonly GeneratedDependency[] = []) {
    return classBean({
      id: clockId,
      source: testSource("clock"),
      target: Clock,
      dependencies,
      create: () => new Clock(),
      hooks: {},
    });
  }

  function rootRegistration(dependencies: readonly GeneratedDependency[] = []) {
    return classBean({
      id: rootId,
      source: testSource("root"),
      target: RootContext,
      scope: "request",
      dependencies,
      create: () => new RootContext(),
      hooks: {},
    });
  }

  // 负向用例的坏形状不能经 classBean 构造——注册助手当场校验，异常会落在被断言的调用之外。
  function rawRegistration(overrides: Record<string, unknown>): GeneratedBeanRegistration {
    return {
      kind: "class",
      id: holderId,
      source: testSource("holder"),
      scope: "singleton",
      target: Holder,
      dependencies: [],
      create: () => new Holder(),
      hooks: {},
      ...overrides,
    } as unknown as GeneratedBeanRegistration; // 坏形状即测试输入，交给运行时校验裁决
  }

  function expectInvalid(definition: unknown, fragment: string): void {
    const create = () => Reflect.apply(createApplicationContext, undefined, [definition]);
    expect(create).toThrow(InvalidGeneratedDefinitionError);
    expect(create).toThrow(fragment);
  }

  test("accepts a request Bean with a current handle edge and carries scope into the snapshot", () => {
    const definition = testDefinition([
      rootRegistration(),
      rawRegistration({ dependencies: [testDependency(0, rootId, "current")] }),
    ]);

    const snapshot = snapshotApplicationDefinition(definition);

    expect(snapshot.registrations.map((registration) => registration.scope)).toEqual([
      "request",
      "singleton",
    ]);
  });

  test("rejects a registration without a scope", () => {
    const definition = testDefinition([rawRegistration({ scope: undefined })]);

    expectInvalid(definition, "scope");
  });

  test("rejects an unknown scope value", () => {
    const definition = testDefinition([rawRegistration({ scope: "session" })]);

    expectInvalid(definition, "scope");
  });

  test("rejects an eager singleton edge onto a request Bean", () => {
    const definition = testDefinition([
      rootRegistration(),
      rawRegistration({ dependencies: [testDependency(0, rootId, "eager")] }),
    ]);

    expectInvalid(definition, "request");
  });

  test("rejects an explicit-lazy edge onto a request Bean", () => {
    const definition = testDefinition([
      rootRegistration(),
      rawRegistration({ dependencies: [testDependency(0, rootId, "explicit-lazy")] }),
    ]);

    expectInvalid(definition, "request");
  });

  test("rejects a current edge onto a singleton", () => {
    const definition = testDefinition([
      clockRegistration(),
      rawRegistration({ dependencies: [testDependency(0, clockId, "current")] }),
    ]);

    expectInvalid(definition, "current");
  });

  test("rejects a current edge declared by a request Bean", () => {
    const definition = testDefinition([
      rootRegistration(),
      rawRegistration({
        id: "src/peer.ts#Peer",
        scope: "request",
        dependencies: [testDependency(0, rootId, "current")],
      }),
    ]);

    expectInvalid(definition, "current");
  });

  test("rejects a collection member targeting a request Bean", () => {
    const definition = testDefinition([
      rootRegistration(),
      rawRegistration({
        dependencies: [testCollectionDependency(0, [{ targetId: rootId, mode: "eager" }])],
      }),
    ]);

    expectInvalid(definition, "request");
  });

  test("rejects a request Bean declaring lifecycle hooks", () => {
    const definition = testDefinition([
      rawRegistration({ id: rootId, scope: "request", hooks: { start: () => undefined } }),
    ]);

    expectInvalid(definition, "request");
  });

  test("rejects a request factory declaring dispose", () => {
    const definition = testDefinition([
      {
        kind: "factory",
        id: "src/trace.ts#trace",
        source: testSource("trace"),
        scope: "request",
        definition: defineBean({ create: () => ({ traced: true }) }),
        dependencies: [],
        create: () => ({ traced: true }),
        dispose: () => undefined,
      },
    ]);

    expectInvalid(definition, "request");
  });

  test("rejects a construction plan listing a request Bean", () => {
    const definition = testDefinition([rootRegistration()], {
      constructionOrder: [rootId],
      requestConstructionOrder: [],
    });

    expectInvalid(definition, "constructionOrder");
  });

  test("rejects a request plan that misses a request Bean", () => {
    const definition = testDefinition([rootRegistration()], {
      requestConstructionOrder: [],
    });

    expectInvalid(definition, "requestConstructionOrder");
  });

  test("rejects a request plan listing a singleton", () => {
    const definition = testDefinition([clockRegistration(), rootRegistration()], {
      requestConstructionOrder: [clockId, rootId],
    });

    expectInvalid(definition, "requestConstructionOrder");
  });

  test("eager request edges must precede their consumer in the request plan", () => {
    const definition = testDefinition(
      [
        rootRegistration(),
        rawRegistration({
          id: "src/peer.ts#Peer",
          scope: "request",
          dependencies: [testDependency(0, rootId, "eager")],
        }),
      ],
      { requestConstructionOrder: ["src/peer.ts#Peer", rootId] },
    );

    expectInvalid(definition, "must place eager dependency");
  });

  test("a request Bean's eager edge onto a singleton needs no plan position", () => {
    const definition = testDefinition([
      clockRegistration(),
      rootRegistration([testDependency(0, clockId, "eager")]),
    ]);

    const snapshot = snapshotApplicationDefinition(definition);

    expect(snapshot.plans.requestConstructionOrder).toEqual([rootId]);
  });

  test("rejects a definition without the requestConstructionOrder plan", () => {
    const { plans, ...rest } = testDefinition([clockRegistration()]);
    const { requestConstructionOrder: _requestConstructionOrder, ...retiredPlans } = plans;

    expectInvalid({ ...rest, plans: retiredPlans }, "requestConstructionOrder");
  });
});

describe("generated definition snapshots", () => {
  function mutablePosition(offset: number) {
    return { offset, line: 0, character: offset };
  }

  test("a snapshot keeps its own copy of a class registration's dependency list", () => {
    class Resource {}
    const dependencies: GeneratedDependency[] = [];
    const registration: GeneratedBeanRegistration = {
      kind: "class",
      id: "src/resource.ts#Resource",
      source: testSource("resource"),
      scope: "singleton",
      target: Resource,
      dependencies,
      create: () => new Resource(),
      hooks: {},
    };

    const snapshot = snapshotApplicationDefinition(testDefinition([registration]));
    dependencies.push(testDependency(0, "src/resource.ts#Resource", "cycle-proxy"));

    expect(snapshot.registrations[0]?.dependencies).toEqual([]);
  });

  test("a snapshot keeps its own copy of a class registration's source positions", () => {
    class Resource {}
    const start = mutablePosition(0);
    const registration: GeneratedBeanRegistration = {
      kind: "class",
      id: "src/resource.ts#Resource",
      source: { file: "src/resource.ts", start, end: mutablePosition(8) },
      scope: "singleton",
      target: Resource,
      dependencies: [],
      create: () => new Resource(),
      hooks: {},
    };

    const snapshot = snapshotApplicationDefinition(testDefinition([registration]));
    start.offset = 99;

    expect(snapshot.registrations[0]?.source.start.offset).toBe(0);
  });

  test("a snapshot keeps its own copy of a factory registration's source positions", () => {
    const start = mutablePosition(0);
    const registration: GeneratedBeanRegistration = {
      kind: "factory",
      id: "src/resource.ts#resource",
      source: { file: "src/resource.ts", start, end: mutablePosition(8) },
      scope: "singleton",
      definition: defineBean({ create: () => ({ connected: true }) }),
      dependencies: [],
      create: () => ({ connected: true }),
    };

    const snapshot = snapshotApplicationDefinition(testDefinition([registration]));
    start.offset = 99;

    expect(snapshot.registrations[0]?.source.start.offset).toBe(0);
  });

  test("a snapshot freezes every cloned registration", () => {
    class Resource {}
    const registration = classBean({
      id: "src/resource.ts#Resource",
      source: testSource("resource"),
      target: Resource,
      dependencies: [],
      create: () => new Resource(),
      hooks: {},
    });

    const snapshot = snapshotApplicationDefinition(testDefinition([registration]));

    expect(Object.isFrozen(snapshot.registrations[0])).toBe(true);
  });
});
