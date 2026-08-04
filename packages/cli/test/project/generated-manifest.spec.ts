import { describe, expect, test } from "bun:test";
import { validateGeneratedManifestBytes } from "@/project/generated-manifest";

function sourceReference(file: string) {
  return {
    file,
    start: { offset: 0, line: 0, character: 0 },
    end: { offset: 1, line: 0, character: 1 },
  };
}

function dependency(targetId: string, mode: "eager" | "cycle-proxy", file: string) {
  return { parameterIndex: 0, targetId, mode, source: sourceReference(file) };
}

interface ClassBeanInput {
  readonly file: string;
  readonly exportName: string;
  readonly specifier?: string;
  readonly start?: boolean;
  readonly close?: boolean;
  readonly dependencies?: readonly object[];
  readonly extraProvides?: readonly object[];
}

function classBean(input: ClassBeanInput) {
  const specifier = input.specifier ?? `../../${input.file.replace(/\.ts$/u, ".js")}`;
  return {
    id: `${input.file}#${input.exportName}`,
    origin: "application",
    kind: "class",
    source: sourceReference(input.file),
    runtimeExport: { moduleSpecifier: specifier, exportName: input.exportName },
    provides: [
      {
        displayName: input.exportName,
        moduleSpecifier: specifier,
        exportName: input.exportName,
        declaration: sourceReference(input.file),
      },
      ...(input.extraProvides ?? []),
    ],
    dependencies: input.dependencies ?? [],
    primary: false,
    qualifiers: [],
    lifecycle: { start: input.start ?? false, close: input.close ?? false, dispose: false },
  };
}

interface Plans {
  readonly constructionOrder: readonly string[];
  readonly startActionOrder: readonly string[];
  readonly cleanupActionOrder: readonly string[];
}

function manifestBytes(beans: readonly object[], plans: Plans): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ schemaVersion: 3, configs: [], beans, plans }));
}

function singleBeanManifestBytes(input: Omit<ClassBeanInput, "file" | "exportName">): Uint8Array {
  const bean = classBean({ ...input, file: "src/resource.ts", exportName: "Resource" });
  return manifestBytes([bean], {
    constructionOrder: [bean.id],
    startActionOrder: [],
    cleanupActionOrder: [],
  });
}

describe("validateGeneratedManifestBytes lifecycle order", () => {
  test("rejects a start order that contradicts the reverse of the cleanup order", () => {
    const first = classBean({ file: "src/a.ts", exportName: "A", start: true, close: true });
    const second = classBean({ file: "src/b.ts", exportName: "B", start: true, close: true });
    const bytes = manifestBytes([first, second], {
      constructionOrder: [first.id, second.id],
      startActionOrder: [first.id, second.id],
      cleanupActionOrder: [first.id, second.id],
    });

    const accepted = validateGeneratedManifestBytes(bytes);

    expect(accepted).toBe(false);
  });

  test("accepts a dependency cycle whose eager dependency starts after its consumer", () => {
    const first = classBean({
      file: "src/a.ts",
      exportName: "A",
      start: true,
      close: true,
      dependencies: [dependency("src/b.ts#B", "eager", "src/a.ts")],
    });
    const second = classBean({
      file: "src/b.ts",
      exportName: "B",
      start: true,
      close: true,
      dependencies: [dependency("src/a.ts#A", "cycle-proxy", "src/b.ts")],
    });
    const bytes = manifestBytes([first, second], {
      constructionOrder: [second.id, first.id],
      startActionOrder: [first.id, second.id],
      cleanupActionOrder: [second.id, first.id],
    });

    const accepted = validateGeneratedManifestBytes(bytes);

    expect(accepted).toBe(true);
  });
});

describe("validateGeneratedManifestBytes runtime specifier", () => {
  test("accepts the canonical specifier that steps out of the generated directory", () => {
    const bytes = singleBeanManifestBytes({ specifier: "../../src/resource.js" });

    const accepted = validateGeneratedManifestBytes(bytes);

    expect(accepted).toBe(true);
  });

  test("rejects a specifier that steps one level above the project root", () => {
    const bytes = singleBeanManifestBytes({ specifier: "../../../src/resource.js" });

    const accepted = validateGeneratedManifestBytes(bytes);

    expect(accepted).toBe(false);
  });

  test("rejects a specifier that walks far outside the project root", () => {
    const bytes = singleBeanManifestBytes({ specifier: "../../../../../../../etc/x.js" });

    const accepted = validateGeneratedManifestBytes(bytes);

    expect(accepted).toBe(false);
  });

  test("rejects a specifier that escapes through a parent segment in the middle", () => {
    const bytes = singleBeanManifestBytes({ specifier: "../../src/../../etc/x.js" });

    const accepted = validateGeneratedManifestBytes(bytes);

    expect(accepted).toBe(false);
  });

  test("accepts a bare package specifier on a provides entry without a declaration", () => {
    const bytes = singleBeanManifestBytes({
      extraProvides: [
        {
          displayName: "ApplicationContext",
          moduleSpecifier: "@reforce/context",
          exportName: "ApplicationContext",
        },
      ],
    });

    const accepted = validateGeneratedManifestBytes(bytes);

    expect(accepted).toBe(true);
  });
});

interface StarterBeanInput {
  readonly origin?: string;
  readonly moduleSpecifier?: string;
  readonly sourceFile?: string;
}

function starterBean(input: StarterBeanInput = {}) {
  return {
    id: "@acme/starter-redis#RedisClient",
    origin: input.origin ?? "@acme/starter-redis@1.2.0",
    kind: "class",
    source: sourceReference(input.sourceFile ?? "src/client.ts"),
    runtimeExport: {
      moduleSpecifier: input.moduleSpecifier ?? "@acme/starter-redis",
      exportName: "RedisClient",
    },
    provides: [
      {
        displayName: "RedisClient",
        moduleSpecifier: input.moduleSpecifier ?? "@acme/starter-redis",
        exportName: "RedisClient",
      },
    ],
    dependencies: [],
    primary: false,
    qualifiers: [],
    lifecycle: { start: false, close: false, dispose: false },
  };
}

function starterManifestBytes(bean: ReturnType<typeof starterBean>): Uint8Array {
  return manifestBytes([bean], {
    constructionOrder: [bean.id],
    startActionOrder: [],
    cleanupActionOrder: [],
  });
}

// starter bean（ADR 0004 决策 16 的 origin 面）：id 为 `包名#导出名`，runtimeExport 是包内裸
// specifier，source 相对包根——与应用 bean 的三条对应不变量分道校验。
describe("validateGeneratedManifestBytes starter origin", () => {
  test("accepts a starter bean with a package origin and bare runtime specifier", () => {
    const accepted = validateGeneratedManifestBytes(starterManifestBytes(starterBean()));

    expect(accepted).toBe(true);
  });

  test("rejects a bean without an origin field", () => {
    const bean = classBean({ file: "src/resource.ts", exportName: "Resource" });
    const { origin: _origin, ...withoutOrigin } = bean;
    const bytes = manifestBytes([withoutOrigin], {
      constructionOrder: [bean.id],
      startActionOrder: [],
      cleanupActionOrder: [],
    });

    const accepted = validateGeneratedManifestBytes(bytes);

    expect(accepted).toBe(false);
  });

  test("rejects a starter origin whose package name disagrees with the bean id", () => {
    const bytes = starterManifestBytes(starterBean({ origin: "@acme/other@1.0.0" }));

    const accepted = validateGeneratedManifestBytes(bytes);

    expect(accepted).toBe(false);
  });

  test("rejects a starter runtime specifier outside the starter package", () => {
    const bytes = starterManifestBytes(starterBean({ moduleSpecifier: "@acme/other" }));

    const accepted = validateGeneratedManifestBytes(bytes);

    expect(accepted).toBe(false);
  });

  test("rejects an application bean whose runtime specifier is a bare package name", () => {
    const bytes = singleBeanManifestBytes({ specifier: "@acme/starter-redis" });

    const accepted = validateGeneratedManifestBytes(bytes);

    expect(accepted).toBe(false);
  });
});

describe("validateGeneratedManifestBytes collection dependencies (schema v3)", () => {
  function collectionDependency(
    members: readonly { readonly targetId: string; readonly mode: string }[],
    file: string,
  ) {
    return { parameterIndex: 0, mode: "collection", members, source: sourceReference(file) };
  }

  function collectionManifestBytes(
    members: readonly { readonly targetId: string; readonly mode: string }[],
    constructionOrder?: readonly string[],
  ): Uint8Array {
    const member = classBean({ file: "src/handler.ts", exportName: "Handler" });
    const registry = classBean({
      file: "src/registry.ts",
      exportName: "Registry",
      dependencies: [collectionDependency(members, "src/registry.ts")],
    });
    return manifestBytes([member, registry], {
      constructionOrder: constructionOrder ?? [member.id, registry.id],
      startActionOrder: [],
      cleanupActionOrder: [],
    });
  }

  test("accepts a collection edge whose eager members precede the consumer", () => {
    const bytes = collectionManifestBytes([{ targetId: "src/handler.ts#Handler", mode: "eager" }]);

    expect(validateGeneratedManifestBytes(bytes)).toBe(true);
  });

  test("accepts an empty member list", () => {
    const bytes = collectionManifestBytes([]);

    expect(validateGeneratedManifestBytes(bytes)).toBe(true);
  });

  test("rejects an eager member constructed after its consumer", () => {
    const bytes = collectionManifestBytes(
      [{ targetId: "src/handler.ts#Handler", mode: "eager" }],
      ["src/registry.ts#Registry", "src/handler.ts#Handler"],
    );

    expect(validateGeneratedManifestBytes(bytes)).toBe(false);
  });

  test("rejects an explicit-lazy member mode", () => {
    const bytes = collectionManifestBytes([
      { targetId: "src/handler.ts#Handler", mode: "explicit-lazy" },
    ]);

    expect(validateGeneratedManifestBytes(bytes)).toBe(false);
  });

  test("rejects duplicate member targets", () => {
    const bytes = collectionManifestBytes([
      { targetId: "src/handler.ts#Handler", mode: "eager" },
      { targetId: "src/handler.ts#Handler", mode: "eager" },
    ]);

    expect(validateGeneratedManifestBytes(bytes)).toBe(false);
  });

  test("rejects a member referencing an unknown Bean", () => {
    const bytes = collectionManifestBytes([{ targetId: "src/missing.ts#Missing", mode: "eager" }]);

    expect(validateGeneratedManifestBytes(bytes)).toBe(false);
  });

  test("rejects a collection edge that also carries a single-target field", () => {
    const member = classBean({ file: "src/handler.ts", exportName: "Handler" });
    const registry = classBean({
      file: "src/registry.ts",
      exportName: "Registry",
      dependencies: [
        {
          parameterIndex: 0,
          mode: "collection",
          targetId: "src/handler.ts#Handler",
          members: [],
          source: sourceReference("src/registry.ts"),
        },
      ],
    });
    const bytes = manifestBytes([member, registry], {
      constructionOrder: [member.id, registry.id],
      startActionOrder: [],
      cleanupActionOrder: [],
    });

    expect(validateGeneratedManifestBytes(bytes)).toBe(false);
  });

  test("accepts an integer order key and rejects a fractional one", () => {
    const ordered = classBean({ file: "src/handler.ts", exportName: "Handler" });
    const plans = {
      constructionOrder: [ordered.id],
      startActionOrder: [],
      cleanupActionOrder: [],
    };

    expect(validateGeneratedManifestBytes(manifestBytes([{ ...ordered, order: -5 }], plans))).toBe(
      true,
    );
    expect(validateGeneratedManifestBytes(manifestBytes([{ ...ordered, order: 1.5 }], plans))).toBe(
      false,
    );
  });
});
