import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type CompileResult, createCompiler, type GeneratedFile } from "@/index";
import { addQualifiedSelectionProbe, createPositiveApplication } from "./support/project";

type CompileSuccess = Extract<CompileResult, { readonly status: "success" }>;
type GeneratedFilePath = GeneratedFile["path"];

const temporaryProjects: TemporaryProject[] = [];
let validSelection: CompileSuccess;

function applicationTsconfig(): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      experimentalDecorators: false,
      emitDecoratorMetadata: false,
    },
    include: ["src", ".reforce/generated/**/*.d.ts"],
  })}\n`;
}

async function compileProject(project: TemporaryProject): Promise<CompileResult> {
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  return compiler.compile({ project: resolution.project });
}

async function compileSource(source: string): Promise<CompileResult> {
  const project = await createTemporaryProject({
    "tsconfig.json": applicationTsconfig(),
    src: { "application.ts": source },
  });
  temporaryProjects.push(project);
  return compileProject(project);
}

function generatedContent(result: CompileSuccess, filePath: GeneratedFilePath): string {
  const content = result.files.find((file) => file.path === filePath)?.content;
  if (content === undefined) {
    throw new Error(`Missing generated file ${filePath}.`);
  }
  return content;
}

function dependencyTarget(result: CompileSuccess, beanId: string, parameterIndex: number): string {
  const manifest: unknown = JSON.parse(generatedContent(result, "manifest.json"));
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error("Generated manifest must be an object.");
  }
  const beans: unknown = Reflect.get(manifest, "beans");
  if (!Array.isArray(beans)) {
    throw new Error("Generated manifest must contain Beans.");
  }
  const bean = beans.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      Reflect.get(candidate, "id") === beanId,
  );
  if (typeof bean !== "object" || bean === null) {
    throw new Error(`Missing generated Bean ${beanId}.`);
  }
  const dependencies: unknown = Reflect.get(bean, "dependencies");
  if (!Array.isArray(dependencies)) {
    throw new Error(`Generated Bean ${beanId} must contain dependencies.`);
  }
  const dependency = dependencies.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      Reflect.get(candidate, "parameterIndex") === parameterIndex,
  );
  if (typeof dependency !== "object" || dependency === null) {
    throw new Error(`Missing dependency ${parameterIndex} for ${beanId}.`);
  }
  const targetId: unknown = Reflect.get(dependency, "targetId");
  if (typeof targetId !== "string") {
    throw new Error(`Dependency ${parameterIndex} for ${beanId} must have a target ID.`);
  }
  return targetId;
}

function diagnostic(result: CompileResult, code: string) {
  return result.diagnostics.find((item) => item.code === code);
}

beforeAll(async () => {
  const project = await createPositiveApplication();
  temporaryProjects.push(project);
  await addQualifiedSelectionProbe(project.projectRoot);
  const result = await compileProject(project);
  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  validSelection = result;
});

afterAll(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

describe("provider selection", () => {
  test("a unique interface candidate is selected", () => {
    expect(
      dependencyTarget(validSelection, "src/qualified-selection.ts#QualifiedSelectionProbe", 2),
    ).toBe("src/providers.ts#UniqueProvider");
  });

  test("one Primary is selected as the unqualified interface default", () => {
    expect(
      dependencyTarget(validSelection, "src/qualified-selection.ts#QualifiedSelectionProbe", 0),
    ).toBe("src/providers.ts#PreferredProvider");
  });

  test("a qualifier selects its exact provider without consulting Primary", () => {
    expect(
      dependencyTarget(validSelection, "src/qualified-selection.ts#QualifiedSelectionProbe", 1),
    ).toBe("src/providers.ts#FallbackProvider");
  });

  test("a Primary factory participates in interface default selection", async () => {
    const result = await compileSource(
      [
        'import { defineBean, Injectable } from "@reforce/context";',
        "export interface Port { value(): string }",
        '@Injectable() export class Other implements Port { value(): string { return "other"; } }',
        'class FactoryValue implements Port { value(): string { return "factory"; } }',
        "export const selected = defineBean<Port>({",
        "  create: (): Port => new FactoryValue(),",
        "  primary: true,",
        "});",
        "@Injectable() export class Consumer { constructor(readonly port: Port) {} }",
      ].join("\n"),
    );
    if (result.status === "failure") {
      throw new Error(JSON.stringify(result.diagnostics));
    }

    const targetId = dependencyTarget(result, "src/application.ts#Consumer", 0);

    expect(targetId).toBe("src/application.ts#selected");
  });

  test("multiple unqualified candidates without Primary are ambiguous", async () => {
    const result = await compileSource(
      [
        'import { Injectable } from "@reforce/context";',
        "export interface Port {}",
        "@Injectable() export class First implements Port {}",
        "@Injectable() export class Second implements Port {}",
        "@Injectable() export class Consumer { constructor(readonly port: Port) {} }",
      ].join("\n"),
    );

    const error = diagnostic(result, "AMBIGUOUS_BEAN");

    expect(result.status).toBe("failure");
    expect(error?.related.map((item) => item.message)).toEqual([
      "src/application.ts#First",
      "src/application.ts#Second",
    ]);
    expect(error?.related.every((item) => item.sourceSpan !== undefined)).toBe(true);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["AMBIGUOUS_BEAN"]);
  });

  test("multiple Primary candidates are rejected", async () => {
    const result = await compileSource(
      [
        'import { Injectable, Primary } from "@reforce/context";',
        "export interface Port {}",
        "@Injectable() @Primary() export class First implements Port {}",
        "@Injectable() @Primary() export class Second implements Port {}",
        "@Injectable() export class Consumer { constructor(readonly port: Port) {} }",
      ].join("\n"),
    );

    const error = diagnostic(result, "MULTIPLE_PRIMARY_BEANS");

    expect(result.status).toBe("failure");
    expect(error?.related.map((item) => item.message)).toEqual([
      "src/application.ts#First",
      "src/application.ts#Second",
    ]);
    expect(error?.related.every((item) => item.sourceSpan !== undefined)).toBe(true);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["MULTIPLE_PRIMARY_BEANS"]);
  });

  test("an unknown qualifier reports every currently available member", async () => {
    const result = await compileSource(
      [
        'import { Injectable, Primary, Qualifier } from "@reforce/context";',
        "export interface Port {}",
        '@Injectable() @Qualifier("Fallback") export class First implements Port {}',
        '@Injectable() @Primary() @Qualifier("Preferred") export class Second implements Port {}',
        "@Injectable() export class Consumer { constructor(readonly port: Port.Removed) {} }",
      ].join("\n"),
    );

    const error = diagnostic(result, "UNKNOWN_BEAN_QUALIFIER");

    expect(result.status).toBe("failure");
    expect(error?.related.map((item) => item.message)).toEqual([
      "Fallback -> src/application.ts#First (Primary: false)",
      "Preferred -> src/application.ts#Second (Primary: true)",
    ]);
    expect(error?.related.every((item) => item.sourceSpan !== undefined)).toBe(true);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["UNKNOWN_BEAN_QUALIFIER"]);
  });

  test("two providers cannot publish the same qualifier member", async () => {
    const result = await compileSource(
      [
        'import { Injectable, Qualifier } from "@reforce/context";',
        "export interface Port {}",
        '@Injectable() @Qualifier("Same") export class First implements Port {}',
        '@Injectable() @Qualifier("Same") export class Second implements Port {}',
      ].join("\n"),
    );

    const error = diagnostic(result, "DUPLICATE_BEAN_QUALIFIER");

    expect(result.status).toBe("failure");
    expect(error?.related.map((item) => item.message)).toEqual([
      "Same -> src/application.ts#First (Primary: false)",
      "Same -> src/application.ts#Second (Primary: false)",
    ]);
    expect(error?.related.every((item) => item.sourceSpan !== undefined)).toBe(true);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["DUPLICATE_BEAN_QUALIFIER"]);
  });

  test("an Injectable class wins over a Primary factory for its concrete type", async () => {
    const result = await compileSource(
      [
        'import { defineBean, Injectable } from "@reforce/context";',
        "@Injectable() export class Concrete {}",
        "export const concreteFactory = defineBean<Concrete>({",
        "  create: () => new Concrete(),",
        "  primary: true,",
        "});",
        "@Injectable()",
        "export class Consumer { constructor(readonly dependency: Concrete) {} }",
        "",
      ].join("\n"),
    );
    if (result.status === "failure") {
      throw new Error(JSON.stringify(result.diagnostics));
    }

    const targetId = dependencyTarget(result, "src/application.ts#Consumer", 0);

    expect(targetId).toBe("src/application.ts#Concrete");
  });
});
