import { describe, expect, test } from "bun:test";
import type { GeneratedBeanRegistration, GeneratedDependency } from "@/generated/contracts";
import { snapshotApplicationDefinition } from "@/generated/validation";
import { classBean, createApplicationContext } from "@/generated-runtime";
import { defineBean, InvalidGeneratedDefinitionError } from "@/index";
import { testDefinition, testDependency, testSource } from "../support/test-definition";

describe("generated definition validation", () => {
  test("a Bean ID must contain a relative path and direct export", () => {
    class Resource {}
    const definition = testDefinition([
      {
        kind: "class",
        id: "../resource.ts#",
        source: testSource("resource"),
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
