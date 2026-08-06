import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import { diagnostic, orderDiagnostics } from "@/diagnostics";
import { type CompileResult, createCompiler } from "@/index";
import type { CanonicalFileId, SourceSpan } from "@/parser/source-location";
import {
  applicationTsconfig,
  type CompilerProjectName,
  createCompilerProject,
  createPositiveApplication,
  resolveProjectOrThrow,
} from "./support/project";

const temporaryProjects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});
async function compileSource(source: string): Promise<CompileResult> {
  const input = await createTemporaryProject({
    "tsconfig.json": applicationTsconfig(),
    src: { "application.ts": source },
  });
  temporaryProjects.push(input);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: input.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  return compiler.compile({ project: resolution.project });
}

async function compileProject(name: CompilerProjectName): Promise<CompileResult> {
  const input = await createCompilerProject(name);
  temporaryProjects.push(input);
  const compiler = createCompiler();
  const project = await resolveProjectOrThrow(compiler, input.projectRoot);
  return compiler.compile({ project });
}

function beanIdCollision(result: CompileResult) {
  return result.diagnostics.find((diagnostic) => diagnostic.code === "BEAN_ID_COLLISION");
}

function sourceSpan(fileId: string): SourceSpan {
  return {
    fileId: fileId as CanonicalFileId, // These fixed relative test paths satisfy the canonical file ID grammar.
    start: { offset: 1, line: 0, character: 1 },
    end: { offset: 2, line: 0, character: 2 },
  };
}

const diagnosticRecords = [
  diagnostic({
    code: "TYPE_LINK_FAILED",
    message: "zeta",
    related: [{ message: "z" }, { message: "a" }, { message: "a" }],
  }),
  diagnostic({ code: "TYPE_LINK_FAILED", message: "alpha" }),
  diagnostic({ code: "TYPE_LINK_FAILED", message: "alpha" }),
];

const projectDiagnostics = [
  [
    "rejects a computed lifecycle method name",
    "computed-lifecycle-method-rejected",
    "INVALID_LIFECYCLE_DECLARATION",
  ],
  [
    "rejects a lifecycle method with an incompatible return type",
    "invalid-lifecycle-return-rejected",
    "INVALID_LIFECYCLE_DECLARATION",
  ],
  [
    "rejects a decorator on a constructor parameter",
    "legacy-parameter-decorator-rejected",
    "INVALID_DECORATOR_USAGE",
  ],
  [
    "rejects a non-inline factory disposer",
    "non-inline-factory-disposer-rejected",
    "INVALID_DEFINE_BEAN",
  ],
  [
    "rejects a qualifier that cannot be emitted as a declaration name",
    "reserved-qualifier-rejected",
    "INVALID_BEAN_QUALIFIER",
  ],
  [
    "rejects a generated qualifier member that already exists",
    "duplicate-generated-qualifier-member",
    "DUPLICATE_BEAN_QUALIFIER",
  ],
] as const;

describe("compiler diagnostics", () => {
  for (const [name, input, code] of projectDiagnostics) {
    test(name, async () => {
      const result = await compileProject(input);

      expect(result.status).toBe("failure");
      expect(result.diagnostics.map((item) => item.code)).toEqual([code]);
    });
  }

  test("diagnostic ordering and exact dedupe are independent of insertion order", () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(diagnosticRecords, {
          minLength: diagnosticRecords.length,
          maxLength: diagnosticRecords.length,
        }),
        (shuffled) => {
          expect(orderDiagnostics(shuffled)).toEqual(orderDiagnostics(diagnosticRecords));
        },
      ),
    );
  });

  test("related information uses full-record ordering and exact dedupe", () => {
    const item = diagnostic({
      code: "TYPE_LINK_FAILED",
      message: "failure",
      related: [
        { message: "a message that must not outrank its span", sourceSpan: sourceSpan("z.ts") },
        { message: "z message", sourceSpan: sourceSpan("a.ts") },
        { message: "z message", sourceSpan: sourceSpan("a.ts") },
      ],
    });

    expect(item.related.map((entry) => String(entry.sourceSpan?.fileId))).toEqual(["a.ts", "z.ts"]);
  });
  test("reports a factory Bean ID collision at the colliding factory declaration", async () => {
    // Arrange
    const source = [
      'import { defineBean } from "@reforce/core";',
      "export interface Resource {}",
      "export const ResourceFactory = defineBean<Resource>({ create: (): Resource => ({}) });",
      "export const resourceFactory = defineBean<Resource>({ create: (): Resource => ({}) });",
      "",
    ].join("\n");

    // Act
    const result = await compileSource(source);

    // Assert
    expect(beanIdCollision(result)?.sourceSpan?.start).toEqual({
      offset: source.indexOf("resourceFactory"),
      line: 3,
      character: 13,
    });
  });

  test("reports a class Bean ID collision at the colliding non-first class declaration", async () => {
    // Arrange
    const source = [
      'import { Injectable } from "@reforce/core";',
      "@Injectable() export class Unrelated {}",
      "@Injectable() export class Service {}",
      "@Injectable() export class service {}",
      "",
    ].join("\n");

    // Act
    const result = await compileSource(source);

    // Assert
    expect(beanIdCollision(result)?.sourceSpan?.start).toEqual({
      offset: source.indexOf("class service"),
      line: 3,
      character: 21,
    });
  });

  test("rejects case-only source identities when the filesystem materializes both files", async () => {
    const input = await createTemporaryProject({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "Service.ts": "export {};\n",
        "service.ts": "export {};\n",
      },
    });
    temporaryProjects.push(input);
    const upperPath = await realpath(path.join(input.projectRoot, "src", "Service.ts"));
    const lowerPath = await realpath(path.join(input.projectRoot, "src", "service.ts"));
    if (upperPath === lowerPath) {
      expect(upperPath).toBe(lowerPath);
      return;
    }
    const compiler = createCompiler();
    const project = await resolveProjectOrThrow(compiler, input.projectRoot);

    const result = await compiler.compile({ project });

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("SOURCE_FILE_ID_COLLISION");
  });

  test("rejects a defineBean declared inside a function body", async () => {
    // Arrange
    const source = [
      'import { defineBean } from "@reforce/core";',
      "export class Resource {}",
      "export function setup(): void {",
      "  const resource = defineBean<Resource>({ create: () => new Resource() });",
      "  void resource;",
      "}",
      "",
    ].join("\n");

    // Act
    const result = await compileSource(source);

    // Assert
    expect(result.diagnostics.map((item) => item.code)).toContain("INVALID_DEFINE_BEAN");
  });

  test("rejects defineBean calls with multiple explicit type arguments", async () => {
    const result = await compileSource(
      [
        'import { defineBean } from "@reforce/core";',
        "export class Resource {}",
        "export const resource = defineBean<Resource, Resource>({",
        "  create: () => new Resource(),",
        "});",
        "",
      ].join("\n"),
    );

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("INVALID_DEFINE_BEAN");
  });

  test("allows a valid lifecycle method beside an unrelated computed method", async () => {
    const result = await compileSource(
      [
        'import { Injectable, type OnContextStart } from "@reforce/core";',
        "@Injectable()",
        "export class Service implements OnContextStart {",
        '  ["format"](value: string): string { return value; }',
        "  onContextStart(): void {}",
        "}",
        "",
      ].join("\n"),
    );

    expect(result.status).toBe("success");
  });

  test("reports unsupported import syntax with its stable diagnostic", async () => {
    const input = await createPositiveApplication();
    temporaryProjects.push(input);
    await writeFile(
      path.join(input.projectRoot, "src", "application.ts"),
      'import Alias = require("package-a");\nexport { Alias };\n',
    );
    const compiler = createCompiler();
    const project = await resolveProjectOrThrow(compiler, input.projectRoot);

    const result = await compiler.compile({ project });

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("UNSUPPORTED_MODULE_SYNTAX");
  });

  test("reports unsupported export syntax with its stable diagnostic", async () => {
    const input = await createPositiveApplication();
    temporaryProjects.push(input);
    await writeFile(
      path.join(input.projectRoot, "src", "application.ts"),
      "const value = {};\nexport = value;\n",
    );
    const compiler = createCompiler();
    const project = await resolveProjectOrThrow(compiler, input.projectRoot);

    const result = await compiler.compile({ project });

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("UNSUPPORTED_MODULE_SYNTAX");
  });

  test("does not misreport an unsupported type declaration as a missing Bean", async () => {
    const result = await compileSource(
      [
        'import { Injectable } from "@reforce/core";',
        "export type ServiceContract = { readonly value: string };",
        "@Injectable()",
        "export class Service {",
        "  constructor(contract: ServiceContract) { void contract; }",
        "}",
        "",
      ].join("\n"),
    );

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toEqual(["UNSUPPORTED_TYPE_DECLARATION"]);
  });
});
