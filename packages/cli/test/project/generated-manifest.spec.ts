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
  return new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, beans, plans }));
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
