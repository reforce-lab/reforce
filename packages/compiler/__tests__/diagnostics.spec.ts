import { afterEach, describe, expect, test } from "bun:test";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import fc from "fast-check";
import { diagnostic, orderDiagnostics } from "../src/diagnostics";
import { type CompileResult, createCompiler } from "../src/index";
import type { CanonicalFileId, SourceSpan } from "../src/parser/source-location";
import {
  applicationTsconfig,
  copyCompilerFixture,
  resolveProjectOrThrow,
} from "./support/compiler-fixture";

const temporaryProjects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

async function compileSource(source: string): Promise<CompileResult> {
  const fixture = await createTemporaryProject({
    "tsconfig.json": applicationTsconfig(),
    src: { "application.ts": source },
  });
  temporaryProjects.push(fixture);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: fixture.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  return compiler.compile({ project: resolution.project });
}

async function compileFixture(name: string): Promise<CompileResult> {
  const fixture = await copyCompilerFixture(name);
  temporaryProjects.push(fixture);
  const compiler = createCompiler();
  const project = await resolveProjectOrThrow(compiler, fixture.projectRoot);
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

const fixtureDiagnostics = [
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
  for (const [name, fixture, code] of fixtureDiagnostics) {
    test(name, async () => {
      const result = await compileFixture(fixture);

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
      'import { defineBean } from "@reforce/context";',
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
      'import { Injectable } from "@reforce/context";',
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
    const fixture = await createTemporaryProject({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "Service.ts": "export {};\n",
        "service.ts": "export {};\n",
      },
    });
    temporaryProjects.push(fixture);
    const upperPath = await realpath(path.join(fixture.projectRoot, "src", "Service.ts"));
    const lowerPath = await realpath(path.join(fixture.projectRoot, "src", "service.ts"));
    if (upperPath === lowerPath) {
      expect(upperPath).toBe(lowerPath);
      return;
    }
    const compiler = createCompiler();
    const project = await resolveProjectOrThrow(compiler, fixture.projectRoot);

    const result = await compiler.compile({ project });

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("SOURCE_FILE_ID_COLLISION");
  });

  test("rejects defineBean calls with multiple explicit type arguments", async () => {
    const result = await compileSource(
      [
        'import { defineBean } from "@reforce/context";',
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
        'import { Injectable, type OnContextStart } from "@reforce/context";',
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
    const fixture = await copyCompilerFixture("standalone-application");
    temporaryProjects.push(fixture);
    await writeFile(
      path.join(fixture.projectRoot, "src", "application.ts"),
      'import Alias = require("package-a");\nexport { Alias };\n',
    );
    const compiler = createCompiler();
    const project = await resolveProjectOrThrow(compiler, fixture.projectRoot);

    const result = await compiler.compile({ project });

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("UNSUPPORTED_MODULE_SYNTAX");
  });

  test("reports unsupported export syntax with its stable diagnostic", async () => {
    const fixture = await copyCompilerFixture("standalone-application");
    temporaryProjects.push(fixture);
    await writeFile(
      path.join(fixture.projectRoot, "src", "application.ts"),
      "const value = {};\nexport = value;\n",
    );
    const compiler = createCompiler();
    const project = await resolveProjectOrThrow(compiler, fixture.projectRoot);

    const result = await compiler.compile({ project });

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("UNSUPPORTED_MODULE_SYNTAX");
  });

  test("does not misreport an unsupported type declaration as a missing Bean", async () => {
    const result = await compileSource(
      [
        'import { Injectable } from "@reforce/context";',
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
