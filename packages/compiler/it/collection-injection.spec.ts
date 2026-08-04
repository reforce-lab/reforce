import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTemporaryProject,
  type ProjectTree,
  resolveBunExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { type CompileResult, createCompiler, type GeneratedFile } from "@/index";
import {
  applicationTsconfig,
  type CompileSuccess,
  linkApplicationPackages,
} from "./support/project";
import { nodeModulesTree, starterMetaSpan, starterPackage } from "./support/starters";

// 集合注入 IT（ADR 0006 W6，#142 / #150）：readonly T[] 是集合边的唯一合法书写（ReadonlyArray<T>
// 等价），成员资格与最终顺序在编译期封闭——@Order(n) 升序优先，同序值与无序成员按 beanId 决胜。
// 空集合合法（≠ MISSING_BEAN），starter bean 与本地 bean 同待遇入集合。生成物 schemaVersion 升 3。

type FailureResult = Extract<CompileResult, { readonly status: "failure" }>;

const bunExecutable = await resolveBunExecutable();
const temporaryProjects: TemporaryProject[] = [];

afterAll(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

async function compileTree(tree: ProjectTree): Promise<{
  readonly project: TemporaryProject;
  readonly result: CompileResult;
}> {
  const project = await createTemporaryProject(tree);
  temporaryProjects.push(project);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  return { project, result: await compiler.compile({ project: resolution.project }) };
}

async function compileSource(source: string): Promise<CompileResult> {
  const { result } = await compileTree({
    "tsconfig.json": applicationTsconfig(),
    src: { "application.ts": source },
  });
  return result;
}

async function compileSourceOrThrow(source: string): Promise<CompileSuccess> {
  const result = await compileSource(source);
  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

function expectFailure(result: CompileResult): FailureResult {
  expect(result.status).toBe("failure");
  if (result.status !== "failure") {
    throw new Error("Expected a failed compilation");
  }
  return result;
}

function generatedContent(result: CompileSuccess, filePath: GeneratedFile["path"]): string {
  const content = result.files.find((file) => file.path === filePath)?.content;
  if (content === undefined) {
    throw new Error(`Missing generated file ${filePath}`);
  }
  return content;
}

interface ManifestCollectionMember {
  readonly targetId: string;
  readonly mode: string;
}

interface ManifestDependency {
  readonly parameterIndex: number;
  readonly mode: string;
  readonly targetId?: string;
  readonly members?: readonly ManifestCollectionMember[];
}

interface ManifestBean {
  readonly id: string;
  readonly order?: number;
  readonly dependencies: readonly ManifestDependency[];
}

function manifestOf(result: CompileSuccess): {
  readonly schemaVersion: number;
  readonly beans: readonly ManifestBean[];
} {
  return JSON.parse(generatedContent(result, "manifest.json"));
}

function manifestBean(result: CompileSuccess, id: string): ManifestBean {
  const bean = manifestOf(result).beans.find((candidate) => candidate.id === id);
  if (bean === undefined) {
    throw new Error(`Missing manifest Bean ${id}`);
  }
  return bean;
}

function collectionMembers(
  result: CompileSuccess,
  beanId: string,
  parameterIndex: number,
): readonly ManifestCollectionMember[] {
  const dependency = manifestBean(result, beanId).dependencies.find(
    (candidate) => candidate.parameterIndex === parameterIndex,
  );
  if (dependency?.mode !== "collection" || dependency.members === undefined) {
    throw new Error(`Dependency ${parameterIndex} of ${beanId} is not a collection edge.`);
  }
  return dependency.members;
}

const handlerContract = ["export interface PaymentHandler {", "  name(): string;", "}"].join("\n");

describe("collection membership and ordering", () => {
  test("all providers of the contract join in beanId order without @Order", async () => {
    const result = await compileSourceOrThrow(
      [
        'import { Injectable } from "@reforce/context";',
        handlerContract,
        '@Injectable() export class Beta implements PaymentHandler { name(): string { return "beta"; } }',
        '@Injectable() export class Alpha implements PaymentHandler { name(): string { return "alpha"; } }',
        "@Injectable() export class Registry {",
        "  constructor(readonly handlers: readonly PaymentHandler[]) {}",
        "}",
      ].join("\n"),
    );

    expect(collectionMembers(result, "src/application.ts#Registry", 0)).toEqual([
      { targetId: "src/application.ts#Alpha", mode: "eager" },
      { targetId: "src/application.ts#Beta", mode: "eager" },
    ]);
  });

  test("@Order sorts ascending ahead of unordered members and records itself in the manifest", async () => {
    const result = await compileSourceOrThrow(
      [
        'import { Injectable, Order } from "@reforce/context";',
        handlerContract,
        // beanId 序为 First < Late < Negative < Unordered；@Order 必须推翻它。
        '@Injectable() @Order(5) export class First implements PaymentHandler { name(): string { return "first"; } }',
        '@Injectable() @Order(10) export class Late implements PaymentHandler { name(): string { return "late"; } }',
        '@Injectable() @Order(-1) export class Negative implements PaymentHandler { name(): string { return "negative"; } }',
        '@Injectable() export class Unordered implements PaymentHandler { name(): string { return "unordered"; } }',
        "@Injectable() export class Registry {",
        "  constructor(readonly handlers: readonly PaymentHandler[]) {}",
        "}",
      ].join("\n"),
    );

    expect(
      collectionMembers(result, "src/application.ts#Registry", 0).map((member) => member.targetId),
    ).toEqual([
      "src/application.ts#Negative",
      "src/application.ts#First",
      "src/application.ts#Late",
      "src/application.ts#Unordered",
    ]);
    expect(manifestBean(result, "src/application.ts#Negative").order).toBe(-1);
    expect(manifestBean(result, "src/application.ts#Unordered").order).toBeUndefined();
  });

  test("equal @Order values fall back to beanId order", async () => {
    const result = await compileSourceOrThrow(
      [
        'import { Injectable, Order } from "@reforce/context";',
        handlerContract,
        '@Injectable() @Order(1) export class Zulu implements PaymentHandler { name(): string { return "zulu"; } }',
        '@Injectable() @Order(1) export class Alpha implements PaymentHandler { name(): string { return "alpha"; } }',
        "@Injectable() export class Registry {",
        "  constructor(readonly handlers: readonly PaymentHandler[]) {}",
        "}",
      ].join("\n"),
    );

    expect(
      collectionMembers(result, "src/application.ts#Registry", 0).map((member) => member.targetId),
    ).toEqual(["src/application.ts#Alpha", "src/application.ts#Zulu"]);
  });

  test("an empty collection is legal and injects no members", async () => {
    const result = await compileSourceOrThrow(
      [
        'import { Injectable } from "@reforce/context";',
        handlerContract,
        "@Injectable() export class Registry {",
        "  constructor(readonly handlers: readonly PaymentHandler[]) {}",
        "}",
      ].join("\n"),
    );

    expect(collectionMembers(result, "src/application.ts#Registry", 0)).toEqual([]);
  });

  test("a factory provider joins the collection", async () => {
    const result = await compileSourceOrThrow(
      [
        'import { defineBean, Injectable } from "@reforce/context";',
        handlerContract,
        'class Manual implements PaymentHandler { name(): string { return "manual"; } }',
        "export const manualHandler = defineBean<PaymentHandler>({ create: () => new Manual() });",
        '@Injectable() export class Direct implements PaymentHandler { name(): string { return "direct"; } }',
        "@Injectable() export class Registry {",
        "  constructor(readonly handlers: readonly PaymentHandler[]) {}",
        "}",
      ].join("\n"),
    );

    expect(
      collectionMembers(result, "src/application.ts#Registry", 0).map((member) => member.targetId),
    ).toEqual(["src/application.ts#Direct", "src/application.ts#manualHandler"]);
  });

  test("ReadonlyArray<T> is the same collection edge as readonly T[]", async () => {
    const result = await compileSourceOrThrow(
      [
        'import { Injectable } from "@reforce/context";',
        handlerContract,
        '@Injectable() export class Only implements PaymentHandler { name(): string { return "only"; } }',
        "@Injectable() export class Registry {",
        "  constructor(readonly handlers: ReadonlyArray<PaymentHandler>) {}",
        "}",
      ].join("\n"),
    );

    expect(
      collectionMembers(result, "src/application.ts#Registry", 0).map((member) => member.targetId),
    ).toEqual(["src/application.ts#Only"]);
  });

  test("a collection member cycling back through its consumer becomes a cycle-proxy member", async () => {
    const result = await compileSourceOrThrow(
      [
        'import { Injectable } from "@reforce/context";',
        handlerContract,
        "@Injectable() export class Registry {",
        "  constructor(readonly handlers: readonly PaymentHandler[]) {}",
        "}",
        "@Injectable() export class Reentrant implements PaymentHandler {",
        "  constructor(readonly registry: Registry) {}",
        '  name(): string { return "reentrant"; }',
        "}",
      ].join("\n"),
    );

    expect(collectionMembers(result, "src/application.ts#Registry", 0)).toEqual([
      { targetId: "src/application.ts#Reentrant", mode: "cycle-proxy" },
    ]);
  });
});

describe("collection injection diagnostics", () => {
  test("a mutable T[] parameter directs the author to readonly T[]", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { Injectable } from "@reforce/context";',
          handlerContract,
          "@Injectable() export class Registry {",
          "  constructor(readonly handlers: PaymentHandler[]) {}",
          "}",
        ].join("\n"),
      ),
    );

    const error = failure.diagnostics.find((item) => item.code === "INVALID_COLLECTION_INJECTION");
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_COLLECTION_INJECTION"]);
    expect(error?.help).toContain("readonly");
  });

  test("a mutable Array<T> parameter directs the author to readonly T[]", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { Injectable } from "@reforce/context";',
          handlerContract,
          "@Injectable() export class Registry {",
          "  constructor(readonly handlers: Array<PaymentHandler>) {}",
          "}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_COLLECTION_INJECTION"]);
  });

  test("Lazy<readonly T[]> is rejected as an unsupported combination", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { Injectable, type Lazy } from "@reforce/context";',
          handlerContract,
          "@Injectable() export class Registry {",
          "  constructor(readonly handlers: Lazy<readonly PaymentHandler[]>) {}",
          "}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_COLLECTION_INJECTION"]);
  });

  test("readonly Lazy<T>[] is rejected as an unsupported combination", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { Injectable, type Lazy } from "@reforce/context";',
          handlerContract,
          "@Injectable() export class Registry {",
          "  constructor(readonly handlers: readonly Lazy<PaymentHandler>[]) {}",
          "}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_COLLECTION_INJECTION"]);
  });

  test("a qualified member element is rejected as an unsupported combination", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { Injectable, Qualifier } from "@reforce/context";',
          handlerContract,
          '@Injectable() @Qualifier("Manual") export class Manual implements PaymentHandler { name(): string { return "manual"; } }',
          "@Injectable() export class Registry {",
          "  constructor(readonly handlers: readonly PaymentHandler.Manual[]) {}",
          "}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_COLLECTION_INJECTION"]);
  });

  test("a nested collection element is rejected", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { Injectable } from "@reforce/context";',
          handlerContract,
          "@Injectable() export class Registry {",
          "  constructor(readonly handlers: readonly (readonly PaymentHandler[])[]) {}",
          "}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_COLLECTION_INJECTION"]);
  });
});

describe("@Order usage diagnostics", () => {
  test("@Order without @Injectable is rejected", async () => {
    const failure = expectFailure(
      await compileSource(
        ['import { Order } from "@reforce/context";', "@Order(1) export class Plain {}"].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_DECORATOR_USAGE"]);
  });

  test("@Order requires exactly one integer literal", async () => {
    const failure = expectFailure(
      await compileSource(
        [
          'import { Injectable, Order } from "@reforce/context";',
          '@Injectable() @Order("first") export class Text {}',
          "@Injectable() @Order(1.5) export class Fractional {}",
          "@Injectable() @Order() export class Missing {}",
          "@Injectable() @Order(1) @Order(2) export class Twice {}",
        ].join("\n"),
      ),
    );

    expect(failure.diagnostics.map((item) => item.code)).toEqual([
      "INVALID_DECORATOR_USAGE",
      "INVALID_DECORATOR_USAGE",
      "INVALID_DECORATOR_USAGE",
      "INVALID_DECORATOR_USAGE",
    ]);
  });
});

describe("generated output schema", () => {
  test("collection edges emit resolveAll typed edges under schemaVersion 3", async () => {
    const result = await compileSourceOrThrow(
      [
        'import { Injectable } from "@reforce/context";',
        handlerContract,
        '@Injectable() export class Only implements PaymentHandler { name(): string { return "only"; } }',
        "@Injectable() export class Registry {",
        "  constructor(readonly handlers: readonly PaymentHandler[]) {}",
        "}",
      ].join("\n"),
    );

    const beans = generatedContent(result, "beans.ts");
    expect(beans).toContain("schemaVersion: 3,");
    expect(beans).toMatch(/resolver\.resolveAll<beanContract\d+>\(0\)/);
    expect(manifestOf(result).schemaVersion).toBe(3);
  });
});

describe("starter members", () => {
  const auditDistDeclaration = [
    "export interface AuditSink {",
    "  write(entry: string): void;",
    "}",
    "export declare class FileSink implements AuditSink {",
    "  write(entry: string): void;",
    "}",
    "export declare class ConsoleSink implements AuditSink {",
    "  write(entry: string): void;",
    "}",
    "",
  ].join("\n");

  const auditDistRuntime = [
    "export class FileSink {",
    "  write(entry) {}",
    "}",
    "export class ConsoleSink {",
    "  write(entry) {}",
    "}",
    "",
  ].join("\n");

  function auditStarter(options: { readonly consoleDefault?: boolean } = {}): ProjectTree {
    return starterPackage({
      name: "@acme/starter-audit",
      version: "1.0.0",
      meta: {
        schemaVersion: 1,
        starterDeps: [],
        symbols: [
          { id: "@acme/starter-audit#AuditSink", file: "dist/index.d.ts", subpaths: ["."] },
          { id: "@acme/starter-audit#ConsoleSink", file: "dist/index.d.ts", subpaths: ["."] },
          { id: "@acme/starter-audit#FileSink", file: "dist/index.d.ts", subpaths: ["."] },
        ],
        beans: [
          {
            id: "@acme/starter-audit#FileSink",
            runtimeExport: { module: "@acme/starter-audit", export: "FileSink" },
            provides: ["@acme/starter-audit#FileSink", "@acme/starter-audit#AuditSink"],
            dependencies: [],
            source: starterMetaSpan("src/file-sink.ts"),
          },
          {
            id: "@acme/starter-audit#ConsoleSink",
            runtimeExport: { module: "@acme/starter-audit", export: "ConsoleSink" },
            provides: ["@acme/starter-audit#ConsoleSink", "@acme/starter-audit#AuditSink"],
            dependencies: [],
            source: starterMetaSpan("src/console-sink.ts"),
            ...(options.consoleDefault === true ? { defaultBean: true } : {}),
          },
        ],
      },
      dist: { "index.d.ts": auditDistDeclaration, "index.js": auditDistRuntime },
    });
  }

  function starterApplicationSources(extraRegistrySource = ""): Record<string, string> {
    return {
      "application.ts": [
        'import { defineApplication } from "@reforce/context";',
        'import auditStarter from "@acme/starter-audit/reforce";',
        "",
        "export default defineApplication({ starters: [auditStarter] });",
        "",
      ].join("\n"),
      "registry.ts": [
        'import { Injectable } from "@reforce/context";',
        'import type { AuditSink } from "@acme/starter-audit";',
        "",
        "@Injectable()",
        "export class SinkRegistry {",
        "  constructor(readonly sinks: readonly AuditSink[]) {}",
        "}",
        extraRegistrySource,
        "",
      ].join("\n"),
    };
  }

  async function compileStarterApplication(
    sources: Record<string, string>,
    starter: ProjectTree,
  ): Promise<CompileResult> {
    const { result } = await compileTree({
      "tsconfig.json": applicationTsconfig(),
      node_modules: nodeModulesTree({ "@acme/starter-audit": starter }),
      src: sources,
    });
    return result;
  }

  test("starter beans join the collection alongside local beans in beanId order", async () => {
    const result = await compileStarterApplication(
      starterApplicationSources(
        [
          "@Injectable()",
          "export class LocalSink implements AuditSink {",
          "  write(entry: string): void {}",
          "}",
        ].join("\n"),
      ),
      auditStarter(),
    );
    if (result.status === "failure") {
      throw new Error(JSON.stringify(result.diagnostics));
    }

    expect(
      collectionMembers(result, "src/registry.ts#SinkRegistry", 0).map((member) => member.targetId),
    ).toEqual([
      "@acme/starter-audit#ConsoleSink",
      "@acme/starter-audit#FileSink",
      "src/registry.ts#LocalSink",
    ]);
  });

  test("a default starter bean stands aside from the collection once another provider exists", async () => {
    const result = await compileStarterApplication(
      starterApplicationSources(),
      auditStarter({ consoleDefault: true }),
    );
    if (result.status === "failure") {
      throw new Error(JSON.stringify(result.diagnostics));
    }

    expect(
      collectionMembers(result, "src/registry.ts#SinkRegistry", 0).map((member) => member.targetId),
    ).toEqual(["@acme/starter-audit#FileSink"]);
  });
});

describe("generated collection execution", () => {
  test("the generated definition typechecks and injects the ordered readonly array", async () => {
    const project = await createTemporaryProject({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "application.ts": [
          'import { Injectable, Order } from "@reforce/context";',
          "export interface PaymentHandler {",
          "  name(): string;",
          "}",
          "@Injectable() @Order(2)",
          'export class Slow implements PaymentHandler { name(): string { return "slow"; } }',
          "@Injectable() @Order(1)",
          'export class Fast implements PaymentHandler { name(): string { return "fast"; } }',
          "@Injectable()",
          'export class Plain implements PaymentHandler { name(): string { return "plain"; } }',
          "@Injectable()",
          "export class Registry {",
          "  constructor(readonly handlers: readonly PaymentHandler[]) {}",
          "  names(): readonly string[] {",
          "    return this.handlers.map((handler) => handler.name());",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    });
    temporaryProjects.push(project);
    await linkApplicationPackages(project.projectRoot);
    const compiler = createCompiler();
    const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
    if (resolution.status === "failure") {
      throw new Error(JSON.stringify(resolution.diagnostics));
    }
    const result = await compiler.compile({ project: resolution.project });
    if (result.status === "failure") {
      throw new Error(JSON.stringify(result.diagnostics));
    }
    const generatedDirectory = path.join(project.projectRoot, ".reforce", "generated");
    await mkdir(generatedDirectory, { recursive: true });
    await Promise.all(
      result.files.map((file) => writeFile(path.join(generatedDirectory, file.path), file.content)),
    );
    await writeFile(
      path.join(project.projectRoot, "integration.ts"),
      [
        'import { bootstrap } from "./.reforce/generated/bootstrap.js";',
        'import { Registry } from "./src/application.js";',
        "",
        "const context = await bootstrap();",
        "const registry = context.get(Registry);",
        "const frozen = Object.isFrozen(registry.handlers);",
        "await context.close();",
        "console.log(JSON.stringify({ names: registry.names(), frozen }));",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(project.projectRoot, "tsconfig.integration.json"),
      `${JSON.stringify(
        {
          extends: "./tsconfig.json",
          compilerOptions: { noEmit: true },
          include: ["src", ".reforce/generated/**/*.ts", "integration.ts"],
        },
        undefined,
        2,
      )}\n`,
    );
    const typescriptPackage = fileURLToPath(import.meta.resolve("typescript/package.json"));
    const typecheck = await runCommand(
      process.execPath,
      [path.join(path.dirname(typescriptPackage), "bin", "tsc"), "-p", "tsconfig.integration.json"],
      { cwd: project.projectRoot },
    );
    expect(typecheck.exitCode).toBe(0);
    expect(typecheck.stderr).toBe("");

    const build = await runCommand(
      process.execPath,
      ["build", "integration.ts", "--target=node", "--format=esm", "--outdir=dist"],
      { cwd: project.projectRoot },
    );
    expect(build.exitCode).toBe(0);
    const execution = await runCommand(
      bunExecutable,
      [path.join(project.projectRoot, "dist", "integration.js")],
      { cwd: project.projectRoot },
    );
    expect(execution.exitCode).toBe(0);
    expect(execution.stdout).toBe(
      JSON.stringify({ names: ["fast", "slow", "plain"], frozen: true }),
    );
  });
});
