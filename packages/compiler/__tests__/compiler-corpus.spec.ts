import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { yukuFrontend } from "@reforce/compiler-yuku";
import type {
  GeneratedDependency,
  GeneratedExecutionPlans,
  GeneratedSourceReference,
} from "@reforce/context/generated-runtime";
import {
  copyFixtureTree,
  createTemporaryProject,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { isObject } from "radashi";
import {
  type Compiler,
  type CompileSuccess,
  createCompiler,
  type GeneratedFile,
  type GeneratedFilePath,
  type ResolvedApplicationProject,
} from "#internal/index";

const fixtureDirectory = fileURLToPath(new URL("../fixtures/", import.meta.url));
const temporaryProjects: TemporaryProject[] = [];
const generatedFilePaths = [
  "beans.ts",
  "qualifiers.d.ts",
  "manifest.json",
  "bootstrap.ts",
] as const satisfies readonly GeneratedFilePath[];

function applicationTsconfig(): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
    },
    include: ["src", ".reforce/generated/**/*.d.ts"],
  })}\n`;
}

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

async function copiedFixture(name: string): Promise<TemporaryProject> {
  const temporary = await createTemporaryProject();
  temporaryProjects.push(temporary);
  await copyFixtureTree(path.join(fixtureDirectory, name, "project"), temporary.projectRoot);
  return temporary;
}

async function fixtureNames(): Promise<readonly string[]> {
  const entries = await readdir(fixtureDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

async function compilerFixtureNames(): Promise<readonly string[]> {
  const names = await Promise.all(
    (await fixtureNames()).map(async (name) => {
      const projectEntries = await readdir(path.join(fixtureDirectory, name, "project"));
      return projectEntries.some((name) => /^tsconfig.*\.json$/u.test(name)) ? name : undefined;
    }),
  );
  return names
    .filter((name) => name !== undefined)
    .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function normalizeProjectPaths(value: unknown, projectRoot: string): unknown {
  if (typeof value === "string") {
    const replaced = value.split(projectRoot).join("<projectRoot>");
    return replaced.includes("<projectRoot>") ? replaced.split(path.sep).join("/") : replaced;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeProjectPaths(item, projectRoot));
  }
  if (!isObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizeProjectPaths(item, projectRoot)]),
  );
}

async function expectedDiagnostics(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(fixtureDirectory, name, "expected", "diagnostics.json"), "utf8"),
  );
}

async function expectedGenerated(name: string): Promise<readonly GeneratedFile[]> {
  const generatedDirectory = path.join(fixtureDirectory, name, "expected", "generated");
  try {
    return await Promise.all(
      generatedFilePaths.map(async (filePath) => ({
        path: filePath,
        content: await readFile(path.join(generatedDirectory, filePath), "utf8"),
      })),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function resolvedProject(
  compiler: Compiler,
  projectDirectory: string,
  tsconfigPath?: string,
): Promise<ResolvedApplicationProject> {
  const result = await compiler.resolveProject({
    projectDirectory,
    ...(tsconfigPath === undefined ? {} : { tsconfigPath }),
  });
  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result.project;
}

async function successfulCompile(
  compiler: Compiler,
  project: ResolvedApplicationProject,
): Promise<CompileSuccess> {
  const result = await compiler.compile({ project, frontend: yukuFrontend });
  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

async function createDirectoryLink(source: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
}

async function linkWorkspacePackage(monorepoRoot: string): Promise<void> {
  await createDirectoryLink(
    path.join(monorepoRoot, "packages", "shared"),
    path.join(monorepoRoot, "node_modules", "@fixture", "shared"),
  );
}

async function writeGeneratedFiles(
  projectRoot: string,
  files: readonly GeneratedFile[],
): Promise<void> {
  const generatedDirectory = path.join(projectRoot, ".reforce", "generated");
  await mkdir(generatedDirectory, { recursive: true });
  await Promise.all(
    files.map((file) => writeFile(path.join(generatedDirectory, file.path), file.content)),
  );
}

function generatedBytes(files: readonly GeneratedFile[]): Uint8Array {
  const value = files.map((file) => [file.path, file.content]);
  return new TextEncoder().encode(JSON.stringify(value));
}

interface ManifestSymbolReference {
  readonly displayName: string;
  readonly moduleSpecifier: string;
  readonly exportName: string;
  readonly declaration?: GeneratedSourceReference;
}

interface ManifestBean {
  readonly id: string;
  readonly kind: "class" | "factory";
  readonly source: GeneratedSourceReference;
  readonly runtimeExport: {
    readonly moduleSpecifier: string;
    readonly exportName: string;
  };
  readonly dependencies: readonly GeneratedDependency[];
  readonly qualifiers: readonly {
    readonly interface: ManifestSymbolReference;
    readonly member: string;
  }[];
  readonly lifecycle: {
    readonly start: boolean;
    readonly close: boolean;
    readonly dispose: boolean;
  };
}

interface GeneratedManifest {
  readonly schemaVersion: 1;
  readonly beans: readonly ManifestBean[];
  readonly plans: GeneratedExecutionPlans;
}

function generatedContent(result: CompileSuccess, filePath: GeneratedFilePath): string {
  const content = result.files.find((file) => file.path === filePath)?.content;
  if (content === undefined) {
    throw new Error(`Missing generated file ${filePath}`);
  }
  return content;
}

function manifestOf(result: CompileSuccess): GeneratedManifest {
  return JSON.parse(generatedContent(result, "manifest.json"));
}

function manifestBean(manifest: GeneratedManifest, id: string): ManifestBean {
  const bean = manifest.beans.find((candidate) => candidate.id === id);
  if (bean === undefined) {
    throw new Error(`Missing manifest Bean ${id}`);
  }
  return bean;
}

function registrationBlock(beans: string, index: number): string {
  const start = beans.indexOf(`const registration${index} =`);
  const end = beans.indexOf("\n\n", start);
  if (start < 0 || end < 0) {
    throw new Error(`Missing generated registration ${index}`);
  }
  return beans.slice(start, end);
}

function embeddedData(value: unknown): string {
  return JSON.stringify(value, undefined, 2)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
    .trimStart();
}

function occurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

describe("compiler fixture goldens", async () => {
  for (const name of await compilerFixtureNames()) {
    test(`${name} matches its committed diagnostics and generated output`, async () => {
      const fixture = await copiedFixture(name);
      const diagnostics = await expectedDiagnostics(name);
      const generated = await expectedGenerated(name);
      const compiler = createCompiler();

      const resolution = await compiler.resolveProject({ projectDirectory: fixture.projectRoot });
      const result =
        resolution.status === "success"
          ? await compiler.compile({ project: resolution.project, frontend: yukuFrontend })
          : resolution;

      expect(normalizeProjectPaths(result.diagnostics, fixture.projectRoot)).toEqual(diagnostics);
      expect(result.status === "success" ? result.files : []).toEqual(generated);
    });
  }
});

describe("application project resolution", () => {
  test("resolves a standalone application from its own directory", async () => {
    const fixture = await copiedFixture("standalone-application");
    const compiler = createCompiler();

    const project = await resolvedProject(compiler, fixture.projectRoot);

    expect(project.projectRoot).toBe(fixture.projectRoot);
    expect(project.tsconfigPath).toBe(path.join(fixture.projectRoot, "tsconfig.json"));
  });

  test("resolves a monorepo application from the application directory", async () => {
    const fixture = await copiedFixture("monorepo-application-selection");
    const appDirectory = path.join(fixture.projectRoot, "apps", "api");
    const compiler = createCompiler();

    const project = await resolvedProject(compiler, appDirectory);

    expect(project.projectRoot).toBe(appDirectory);
  });

  test("resolves the project directory selected relative to a monorepo root", async () => {
    const fixture = await copiedFixture("monorepo-application-selection");
    const selectedDirectory = path.resolve(fixture.projectRoot, "apps", "admin");
    const compiler = createCompiler();

    const project = await resolvedProject(compiler, selectedDirectory);

    expect(project.projectRoot).toBe(selectedDirectory);
    expect(project.selectionBoundary).toBe(selectedDirectory);
  });

  test("selects a nested config explicitly from a monorepo root", async () => {
    const fixture = await copiedFixture("monorepo-application-selection");
    const compiler = createCompiler();

    const project = await resolvedProject(
      compiler,
      fixture.projectRoot,
      path.join("apps", "api", "tsconfig.json"),
    );

    expect(project.projectRoot).toBe(path.join(fixture.projectRoot, "apps", "api"));
    expect(project.selectionBoundary).toBe(fixture.projectRoot);
  });

  test("does not descend from a solution config into referenced applications", async () => {
    const fixture = await copiedFixture("monorepo-application-selection");
    const compiler = createCompiler();

    const result = await compiler.resolveProject({
      projectDirectory: fixture.projectRoot,
    });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "PROJECT_CONFIG_NOT_FOUND",
      ]);
    }
  });

  test("reports every valid direct config when automatic selection is ambiguous", async () => {
    const fixture = await copiedFixture("ambiguous-leaf-config");
    const compiler = createCompiler();

    const result = await compiler.resolveProject({
      projectDirectory: fixture.projectRoot,
    });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_PROJECT_CONFIG");
      expect(result.diagnostics[0]?.related.map((item) => item.message)).toEqual([
        path.join(fixture.projectRoot, "tsconfig.app.json"),
        path.join(fixture.projectRoot, "tsconfig.worker.json"),
      ]);
    }
  });

  test("selects one direct config when the ambiguous application is explicit", async () => {
    const fixture = await copiedFixture("ambiguous-leaf-config");
    const compiler = createCompiler();

    const project = await resolvedProject(compiler, fixture.projectRoot, "tsconfig.worker.json");

    expect(project.tsconfigPath).toBe(path.join(fixture.projectRoot, "tsconfig.worker.json"));
  });

  test("canonicalizes symlink, parent-segment, and case-only aliases to one identity", async () => {
    const container = await createTemporaryProject();
    temporaryProjects.push(container);
    const applicationDirectory = path.join(container.projectRoot, "real", "app");
    await mkdir(applicationDirectory, { recursive: true });
    await copyFixtureTree(
      path.join(fixtureDirectory, "standalone-application", "project"),
      applicationDirectory,
    );
    const alias = path.join(container.projectRoot, "Application");
    const caseAlias = path.join(container.projectRoot, "application");
    await createDirectoryLink(applicationDirectory, alias);
    try {
      await realpath(caseAlias);
    } catch {
      await createDirectoryLink(applicationDirectory, caseAlias);
    }
    const compiler = createCompiler();

    const direct = await resolvedProject(compiler, applicationDirectory);
    const aliased = await resolvedProject(
      compiler,
      path.join(container.projectRoot, "real", "..", "Application"),
    );
    const caseAliased = await resolvedProject(compiler, caseAlias);

    expect(aliased.projectRoot).toBe(direct.projectRoot);
    expect(aliased.tsconfigPath).toBe(direct.tsconfigPath);
    expect(caseAliased.projectRoot).toBe(direct.projectRoot);
    expect(caseAliased.tsconfigPath).toBe(direct.tsconfigPath);
  });

  test("rejects an application source included from outside the leaf project root", async () => {
    const fixture = await createTemporaryProject({
      apps: {
        api: {
          src: {
            "application.ts": "export class ApplicationService {}\n",
          },
          "tsconfig.json": `${JSON.stringify({
            compilerOptions: {
              target: "ESNext",
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true,
            },
            include: ["src", "../../shared.ts", ".reforce/generated/**/*.d.ts"],
          })}\n`,
        },
      },
      "shared.ts": "export interface SharedContract {}\n",
    });
    temporaryProjects.push(fixture);
    const compiler = createCompiler();

    const result = await compiler.resolveProject({
      projectDirectory: path.join(fixture.projectRoot, "apps", "api"),
    });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "SOURCE_OUTSIDE_PROJECT_ROOT",
      ]);
    }
  });
});

describe("application compilation fixtures", () => {
  test("does not flatten a namespace export into named exports", async () => {
    // Arrange
    const fixture = await createTemporaryProject({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "application.ts": [
          'import { Injectable } from "@reforce/context";',
          'import type { Port } from "./barrel";',
          "@Injectable()",
          "export class Consumer {",
          "  constructor(readonly dependency: Port) {}",
          "}",
          "",
        ].join("\n"),
        "barrel.ts": 'export * as Ports from "./ports";\n',
        "ports.ts": "export interface Port {}\n",
      },
    });
    temporaryProjects.push(fixture);
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    // Act
    const result = await compiler.compile({ project, frontend: yukuFrontend });

    // Assert
    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("TYPE_LINK_FAILED");
  });

  test("does not treat a local class in an implements clause as a provided contract", async () => {
    // Arrange
    const fixture = await createTemporaryProject({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "application.ts": [
          'import { Injectable } from "@reforce/context";',
          "export class BaseClass {}",
          "@Injectable()",
          "export class Implementation implements BaseClass {}",
          "@Injectable()",
          "export class Consumer {",
          "  constructor(readonly dependency: BaseClass) {}",
          "}",
          "",
        ].join("\n"),
      },
    });
    temporaryProjects.push(fixture);
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    // Act
    const result = await compiler.compile({ project, frontend: yukuFrontend });

    // Assert
    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("MISSING_BEAN");
  });

  test("does not treat an external class in an implements clause as a provided contract", async () => {
    // Arrange
    const fixture = await createTemporaryProject({
      "tsconfig.json": applicationTsconfig(),
      node_modules: {
        "external-contract": {
          "package.json": `${JSON.stringify({
            name: "external-contract",
            version: "1.0.0",
            type: "module",
            exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
          })}\n`,
          "index.d.ts": "export declare class BaseClass {}\n",
          "index.js": "export class BaseClass {}\n",
        },
      },
      src: {
        "application.ts": [
          'import { Injectable } from "@reforce/context";',
          'import type { BaseClass } from "external-contract";',
          "@Injectable()",
          "export class Implementation implements BaseClass {}",
          "@Injectable()",
          "export class Consumer {",
          "  constructor(readonly dependency: BaseClass) {}",
          "}",
          "",
        ].join("\n"),
      },
    });
    temporaryProjects.push(fixture);
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    // Act
    const result = await compiler.compile({ project, frontend: yukuFrontend });

    // Assert
    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("MISSING_BEAN");
  });

  test("rejects type arguments applied to a non-generic provided interface", async () => {
    // Arrange
    const fixture = await createTemporaryProject({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "application.ts": [
          'import { Injectable } from "@reforce/context";',
          "export interface Port {}",
          "@Injectable()",
          "export class Provider implements Port<string> {}",
          "",
        ].join("\n"),
      },
    });
    temporaryProjects.push(fixture);
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    // Act
    const result = await compiler.compile({ project, frontend: yukuFrontend });

    // Assert
    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("UNSUPPORTED_GENERIC_INTERFACE");
  });

  test("rejects defineBean calls with multiple explicit type arguments", async () => {
    // Arrange
    const fixture = await createTemporaryProject({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "application.ts": [
          'import { defineBean } from "@reforce/context";',
          "export class Resource {}",
          "export const resource = defineBean<Resource, Resource>({",
          "  create: () => new Resource(),",
          "});",
          "",
        ].join("\n"),
      },
    });
    temporaryProjects.push(fixture);
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    // Act
    const result = await compiler.compile({ project, frontend: yukuFrontend });

    // Assert
    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("INVALID_DEFINE_BEAN");
  });

  test("rejects a generic parent of a provided application interface", async () => {
    // Arrange
    const fixture = await createTemporaryProject({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "application.ts": [
          'import { Injectable } from "@reforce/context";',
          "export interface Parent<T> {}",
          "export interface Port extends Parent<string> {}",
          "@Injectable()",
          "export class Provider implements Port {}",
          "",
        ].join("\n"),
      },
    });
    temporaryProjects.push(fixture);
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    // Act
    const result = await compiler.compile({ project, frontend: yukuFrontend });

    // Assert
    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("UNSUPPORTED_GENERIC_INTERFACE");
  });

  test("rejects an external parent of a provided application interface", async () => {
    // Arrange
    const fixture = await createTemporaryProject({
      "tsconfig.json": applicationTsconfig(),
      node_modules: {
        "external-contract": {
          "package.json": `${JSON.stringify({
            name: "external-contract",
            version: "1.0.0",
            type: "module",
            exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
          })}\n`,
          "index.d.ts": "export interface Parent {}\n",
          "index.js": "export {};\n",
        },
      },
      src: {
        "application.ts": [
          'import { Injectable } from "@reforce/context";',
          'import type { Parent } from "external-contract";',
          "export interface Port extends Parent {}",
          "@Injectable()",
          "export class Provider implements Port {}",
          "",
        ].join("\n"),
      },
    });
    temporaryProjects.push(fixture);
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    // Act
    const result = await compiler.compile({ project, frontend: yukuFrontend });

    // Assert
    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("TYPE_LINK_FAILED");
  });

  test("rejects an unsupported parent of a provided application interface", async () => {
    // Arrange
    const fixture = await createTemporaryProject({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "application.ts": [
          'import { Injectable } from "@reforce/context";',
          "export type Parent = {};",
          "export interface Port extends Parent {}",
          "@Injectable()",
          "export class Provider implements Port {}",
          "",
        ].join("\n"),
      },
    });
    temporaryProjects.push(fixture);
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    // Act
    const result = await compiler.compile({ project, frontend: yukuFrontend });

    // Assert
    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("UNSUPPORTED_TYPE_DECLARATION");
  });

  test("selects an Injectable class over a Primary factory of the same concrete type", async () => {
    // Arrange
    const fixture = await createTemporaryProject({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "application.ts": [
          'import { defineBean, Injectable } from "@reforce/context";',
          "@Injectable()",
          "export class Concrete {}",
          "export const concreteFactory = defineBean<Concrete>({",
          "  create: () => new Concrete(),",
          "  primary: true,",
          "});",
          "@Injectable()",
          "export class Consumer {",
          "  constructor(readonly dependency: Concrete) {}",
          "}",
          "",
        ].join("\n"),
      },
    });
    temporaryProjects.push(fixture);
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    // Act
    const result = await successfulCompile(compiler, project);

    // Assert
    expect(
      manifestBean(manifestOf(result), "src/application.ts#Consumer").dependencies[0]?.targetId,
    ).toBe("src/application.ts#Concrete");
  });

  test("allows a valid lifecycle method beside an unrelated computed method", async () => {
    // Arrange
    const fixture = await createTemporaryProject({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "application.ts": [
          'import { Injectable, type OnContextStart } from "@reforce/context";',
          "@Injectable()",
          "export class Service implements OnContextStart {",
          '  ["format"](value: string): string { return value; }',
          "  onContextStart(): void {}",
          "}",
          "",
        ].join("\n"),
      },
    });
    temporaryProjects.push(fixture);
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    // Act
    const result = await compiler.compile({ project, frontend: yukuFrontend });

    // Assert
    expect(result.status).toBe("success");
  });

  test("keeps physically distinct copies of one package as distinct type identities", async () => {
    const packageManifest = `${JSON.stringify({
      name: "shared-contract",
      version: "1.0.0",
      type: "module",
      exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
    })}\n`;
    const contractPackage = {
      "package.json": packageManifest,
      "index.d.ts": "export interface Port { readonly value: string }\n",
    };
    const fixture = await createTemporaryProject({
      "tsconfig.json": `${JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
        },
        include: ["src", ".reforce/generated/**/*.d.ts"],
      })}\n`,
      src: {
        left: {
          node_modules: { "shared-contract": contractPackage },
          "provider.ts": [
            'import { Injectable } from "@reforce/context";',
            'import type { Port } from "shared-contract";',
            "@Injectable()",
            'export class LeftProvider implements Port { readonly value = "left"; }',
            "",
          ].join("\n"),
        },
        right: {
          node_modules: { "shared-contract": contractPackage },
          "application.ts": [
            'import { Injectable } from "@reforce/context";',
            'import type { Port } from "shared-contract";',
            "@Injectable()",
            'export class RightProvider implements Port { readonly value = "right"; }',
            "@Injectable()",
            "export class Consumer {",
            "  constructor(readonly port: Port) {}",
            "}",
            "",
          ].join("\n"),
        },
      },
    });
    temporaryProjects.push(fixture);
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    const result = await compiler.compile({ project, frontend: yukuFrontend });

    expect(result.status).toBe("success");
  });

  test("rejects a package that has no public type declaration endpoint", async () => {
    const fixture = await createTemporaryProject({
      "tsconfig.json": `${JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
        },
        include: ["src", ".reforce/generated/**/*.d.ts"],
      })}\n`,
      node_modules: {
        "runtime-only": {
          "package.json": `${JSON.stringify({
            name: "runtime-only",
            version: "1.0.0",
            type: "module",
            exports: { ".": "./index.mjs" },
          })}\n`,
          "index.mjs": "export class Port {}\n",
        },
      },
      src: {
        "application.ts": [
          'import { Injectable } from "@reforce/context";',
          'import type { Port } from "runtime-only";',
          "@Injectable()",
          "export class Consumer {",
          "  constructor(readonly port: Port) {}",
          "}",
          "",
        ].join("\n"),
      },
    });
    temporaryProjects.push(fixture);
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    const result = await compiler.compile({ project, frontend: yukuFrontend });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics.map((item) => item.code)).toContain("TYPE_LINK_FAILED");
    }
  });

  test("resolves public type entries through effective custom conditions", async () => {
    const fixture = await createTemporaryProject({
      "tsconfig.json": `${JSON.stringify({
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "Bundler",
          customConditions: ["reforce-test"],
          strict: true,
        },
        include: ["src", ".reforce/generated/**/*.d.ts"],
      })}\n`,
      node_modules: {
        "conditioned-contract": {
          "package.json": `${JSON.stringify({
            name: "conditioned-contract",
            version: "1.0.0",
            type: "module",
            exports: {
              ".": {
                "reforce-test": "./custom.d.ts",
                types: "./default.d.ts",
                default: "./index.mjs",
              },
            },
          })}\n`,
          "custom.d.ts": "export interface Port { readonly custom: true }\n",
          "default.d.ts": "export interface Port { readonly fallback: true }\n",
          "index.mjs": "export {};\n",
        },
      },
      src: {
        "application.ts": [
          'import { Injectable } from "@reforce/context";',
          'import type { Port } from "conditioned-contract";',
          "@Injectable()",
          "export class Provider implements Port { readonly custom = true as const; }",
          "",
        ].join("\n"),
      },
    });
    temporaryProjects.push(fixture);
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    const result = await compiler.compile({ project, frontend: yukuFrontend });

    expect(result.status).toBe("success");
    expect(result.watchInputs.fileDependencies).toContain(
      path.join(fixture.projectRoot, "node_modules", "conditioned-contract", "custom.d.ts"),
    );
    expect(result.watchInputs.fileDependencies).not.toContain(
      path.join(fixture.projectRoot, "node_modules", "conditioned-contract", "default.d.ts"),
    );
  });

  test("keeps generated output isolated between sibling applications", async () => {
    const fixture = await copiedFixture("monorepo-application-selection");
    await linkWorkspacePackage(fixture.projectRoot);
    const apiRoot = path.join(fixture.projectRoot, "apps", "api");
    const adminRoot = path.join(fixture.projectRoot, "apps", "admin");
    const apiCompiler = createCompiler();
    const adminCompiler = createCompiler();
    const [apiProject, adminProject] = await Promise.all([
      resolvedProject(apiCompiler, apiRoot),
      resolvedProject(adminCompiler, adminRoot),
    ]);
    const [apiResult, adminResult] = await Promise.all([
      successfulCompile(apiCompiler, apiProject),
      successfulCompile(adminCompiler, adminProject),
    ]);

    await Promise.all([
      writeGeneratedFiles(apiRoot, apiResult.files),
      writeGeneratedFiles(adminRoot, adminResult.files),
    ]);

    const [apiManifest, adminManifest] = await Promise.all([
      readFile(path.join(apiRoot, ".reforce", "generated", "manifest.json"), "utf8"),
      readFile(path.join(adminRoot, ".reforce", "generated", "manifest.json"), "utf8"),
    ]);
    expect(apiManifest).toContain("ApiService");
    expect(apiManifest).not.toContain("AdminService");
    expect(adminManifest).toContain("AdminService");
    expect(adminManifest).not.toContain("ApiService");
  });

  test("links package exports, paths, and package imports without discovering shared Beans", async () => {
    const fixture = await copiedFixture("monorepo-application-selection");
    await linkWorkspacePackage(fixture.projectRoot);
    const appRoot = path.join(fixture.projectRoot, "apps", "api");
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, appRoot);

    const result = await successfulCompile(compiler, project);

    const manifest = result.files.find((file) => file.path === "manifest.json");
    expect(manifest?.content).toContain('"moduleSpecifier": "@fixture/shared"');
    expect(manifest?.content).toContain('"moduleSpecifier": "@shared/path"');
    expect(manifest?.content).toContain('"moduleSpecifier": "#shared-contract"');
    expect(manifest?.content).not.toContain("HiddenSharedBean");
  });

  test("watches a shared config extended from outside the application root", async () => {
    const fixture = await copiedFixture("monorepo-application-selection");
    const appRoot = path.join(fixture.projectRoot, "apps", "api");
    const compiler = createCompiler();

    const resolution = await compiler.resolveProject({
      projectDirectory: appRoot,
    });

    expect(resolution.status).toBe("success");
    expect(resolution.watchInputs.fileDependencies).toContain(
      path.join(fixture.projectRoot, "tsconfig.shared.json"),
    );
  });

  test("returns no generated files after the resolved config is replaced", async () => {
    const fixture = await copiedFixture("standalone-application");
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);
    const configPath = path.join(fixture.projectRoot, "tsconfig.json");
    const replacementPath = path.join(fixture.projectRoot, "tsconfig.replacement.json");
    const backupPath = path.join(fixture.projectRoot, "tsconfig.original.json");
    const config = await readFile(configPath, "utf8");
    await writeFile(replacementPath, config.replace('"strict": true', '"strict": false'));
    await rename(configPath, backupPath);
    await rename(replacementPath, configPath);

    const result = await compiler.compile({ project, frontend: yukuFrontend });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "PROJECT_CONFIG_CHANGED",
      ]);
      expect("files" in result).toBe(false);
    }
  });

  test("reports unsupported import syntax with its stable diagnostic", async () => {
    const fixture = await copiedFixture("standalone-application");
    await writeFile(
      path.join(fixture.projectRoot, "src", "application.ts"),
      'import Alias = require("package-a");\nexport { Alias };\n',
    );
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    const result = await compiler.compile({ project, frontend: yukuFrontend });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics.map((item) => item.code)).toContain("UNSUPPORTED_MODULE_SYNTAX");
    }
  });

  test("reports unsupported export syntax with its stable diagnostic", async () => {
    const fixture = await copiedFixture("standalone-application");
    await writeFile(
      path.join(fixture.projectRoot, "src", "application.ts"),
      "const value = {};\nexport = value;\n",
    );
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    const result = await compiler.compile({ project, frontend: yukuFrontend });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics.map((item) => item.code)).toContain("UNSUPPORTED_MODULE_SYNTAX");
    }
  });

  test("does not misreport an unsupported type declaration as a missing Bean", async () => {
    const fixture = await copiedFixture("standalone-application");
    await writeFile(
      path.join(fixture.projectRoot, "src", "application.ts"),
      [
        'import { Injectable } from "@reforce/context";',
        "export type ServiceContract = { readonly value: string };",
        "@Injectable()",
        "export class Service {",
        "  constructor(contract: ServiceContract) {",
        "    void contract;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    const result = await compiler.compile({ project, frontend: yukuFrontend });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics.map((item) => item.code)).toEqual(["UNSUPPORTED_TYPE_DECLARATION"]);
    }
  });

  test("emits identical bytes for cold, warm, and shuffled inputs", async () => {
    const ordered = await copiedFixture("deterministic-cycle-generation");
    const shuffled = await copiedFixture("deterministic-cycle-generation");
    const shuffledConfigPath = path.join(shuffled.projectRoot, "tsconfig.json");
    const shuffledConfig = await readFile(shuffledConfigPath, "utf8");
    await writeFile(
      shuffledConfigPath,
      shuffledConfig.replace('["src/zeta.ts", "src/alpha.ts"]', '["src/alpha.ts", "src/zeta.ts"]'),
    );
    const warmCompiler = createCompiler();
    const coldCompiler = createCompiler();
    const shuffledCompiler = createCompiler();
    const warmProject = await resolvedProject(warmCompiler, ordered.projectRoot);
    const coldProject = await resolvedProject(coldCompiler, ordered.projectRoot);
    const shuffledProject = await resolvedProject(shuffledCompiler, shuffled.projectRoot);

    const cold = await successfulCompile(coldCompiler, coldProject);
    const firstWarm = await successfulCompile(warmCompiler, warmProject);
    const secondWarm = await successfulCompile(warmCompiler, warmProject);
    const shuffledResult = await successfulCompile(shuffledCompiler, shuffledProject);

    expect(generatedBytes(firstWarm.files)).toEqual(generatedBytes(cold.files));
    expect(generatedBytes(secondWarm.files)).toEqual(generatedBytes(cold.files));
    expect(generatedBytes(shuffledResult.files)).toEqual(generatedBytes(cold.files));
  });

  test("keeps cycle proxy and lifecycle ordering deterministic", async () => {
    const fixture = await copiedFixture("deterministic-cycle-generation");
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    const result = await successfulCompile(compiler, project);

    const manifest = result.files.find((file) => file.path === "manifest.json")?.content ?? "";
    expect(manifest.match(/"mode": "cycle-proxy"/gu)).toHaveLength(1);
    expect(manifest).toMatch(
      /"mode": "cycle-proxy"[\s\S]*?"targetId": "src\/alpha\.ts#AlphaService"/u,
    );
    expect(manifest).toContain(
      '"startActionOrder": [\n      "src/alpha.ts#AlphaService",\n      "src/zeta.ts#ZetaService"\n    ]',
    );
    expect(manifest).toContain(
      '"cleanupActionOrder": [\n      "src/zeta.ts#ZetaService",\n      "src/alpha.ts#AlphaService"\n    ]',
    );
  });

  test("emits dependency sources for complete constructor parameters", async () => {
    const fixture = await copiedFixture("generated-runtime-contract");
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);
    const sourceText = await readFile(
      path.join(fixture.projectRoot, "src", "application.ts"),
      "utf8",
    );

    const result = await successfulCompile(compiler, project);
    const manifest = manifestOf(result);
    const parameterSources = manifest.beans.flatMap((bean) =>
      bean.dependencies.map((dependency) =>
        sourceText.slice(dependency.source.start.offset, dependency.source.end.offset),
      ),
    );

    expect(parameterSources).toEqual([
      "readonly beta: BetaService",
      "readonly resource: Lazy<ManagedResource>",
      "readonly alpha: AlphaService",
    ]);
  });

  test("merges interface augmentations that target the same module", async () => {
    const fixture = await copiedFixture("generated-runtime-contract");
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    const result = await successfulCompile(compiler, project);
    const qualifiers = generatedContent(result, "qualifiers.d.ts");
    const target = 'declare module "../../src/contracts.js"';

    expect(occurrences(qualifiers, target)).toBe(1);
    expect(qualifiers).toContain(
      [
        `${target} {`,
        "  namespace AlphaPort {",
        '    type AlphaService = QualifiedBean<InterfaceType0, "src/application.ts#AlphaService">;',
        "  }",
        "",
        "  namespace BetaPort {",
        '    type BetaService = QualifiedBean<InterfaceType1, "src/application.ts#BetaService">;',
        "  }",
        "}",
      ].join("\n"),
    );
  });

  test("keeps generated registration, manifest, qualifier, and plan data consistent", async () => {
    const fixture = await copiedFixture("generated-runtime-contract");
    const compiler = createCompiler();
    const project = await resolvedProject(compiler, fixture.projectRoot);

    const result = await successfulCompile(compiler, project);
    const beans = generatedContent(result, "beans.ts");
    const qualifiers = generatedContent(result, "qualifiers.d.ts");
    const manifest = manifestOf(result);
    const dependencies = manifest.beans.flatMap((bean) => bean.dependencies);

    expect(new Set(dependencies.map((dependency) => dependency.mode))).toEqual(
      new Set(["eager", "cycle-proxy", "explicit-lazy"]),
    );
    expect(manifestBean(manifest, "src/application.ts#AlphaService").lifecycle).toEqual({
      start: true,
      close: true,
      dispose: false,
    });
    expect(manifestBean(manifest, "src/application.ts#managedResource").lifecycle).toEqual({
      start: false,
      close: false,
      dispose: true,
    });

    for (const [index, bean] of manifest.beans.entries()) {
      const registration = registrationBlock(beans, index);
      expect(beans).toContain(
        `import { ${bean.runtimeExport.exportName} as beanTarget${index} } from ${JSON.stringify(bean.runtimeExport.moduleSpecifier)};`,
      );
      expect(registration).toContain(`id: ${JSON.stringify(bean.id)},`);
      expect(registration).toContain(`source: ${embeddedData(bean.source)},`);

      if (bean.kind === "factory") {
        expect(bean.dependencies).toEqual([]);
        expect(registration).toContain(`const registration${index} = factoryBean({`);
        expect(registration).toContain(`definition: beanTarget${index},`);
        expect(registration).not.toContain("dependencies:");
      } else {
        const argumentsList = bean.dependencies
          .map((dependency) =>
            dependency.mode === "explicit-lazy"
              ? `resolver.lazy(${dependency.parameterIndex})`
              : `resolver.resolve(${dependency.parameterIndex})`,
          )
          .join(", ");
        expect(registration).toContain(`const registration${index} = classBean({`);
        expect(registration).toContain(`dependencies: ${embeddedData(bean.dependencies)},`);
        expect(registration).toContain(
          `create: (resolver) => new beanTarget${index}(${argumentsList}),`,
        );
        expect(registration.includes("start: (bean) => bean.onContextStart(),")).toBe(
          bean.lifecycle.start,
        );
        expect(registration.includes("close: (bean) => bean.onContextClose(),")).toBe(
          bean.lifecycle.close,
        );
      }

      for (const qualifier of bean.qualifiers) {
        expect(qualifiers).toContain(
          `declare module ${JSON.stringify(qualifier.interface.moduleSpecifier)}`,
        );
        const memberLine = qualifiers
          .split("\n")
          .find((line) => line.includes(`type ${qualifier.member} = QualifiedBean<`));
        expect(memberLine).toContain(JSON.stringify(bean.id));
      }
    }

    expect(beans).toContain(`plans: ${embeddedData(manifest.plans)},`);
  });
});
