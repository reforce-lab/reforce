import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createTemporaryProject,
  type FixtureTree,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { type CompileResult, createCompiler } from "../src/index";
import {
  applicationTsconfig,
  compileProjectOrThrow,
  copyCompilerFixture,
  resolveProjectOrThrow,
} from "./support/compiler-fixture";

const temporaryProjects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

function applicationSource(packageName: string): string {
  return [
    'import { Injectable } from "@reforce/context";',
    `import type { Port } from ${JSON.stringify(packageName)};`,
    "@Injectable()",
    "export class Provider implements Port {}",
    "",
  ].join("\n");
}

function applicationTree(packageName: string, packageTree?: FixtureTree): FixtureTree {
  return {
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
      },
      include: ["src", ".reforce/generated/**/*.d.ts"],
    })}\n`,
    ...(packageTree === undefined ? {} : { node_modules: { [packageName]: packageTree } }),
    src: { "application.ts": applicationSource(packageName) },
  };
}

function declarationPackageManifest(typeEntry = "./index.d.ts"): string {
  return `${JSON.stringify({
    name: "external-contract",
    version: "1.0.0",
    type: "module",
    exports: { ".": { types: typeEntry, default: "./index.js" } },
  })}\n`;
}

function declarationPackage(files: FixtureTree): FixtureTree {
  return {
    "package.json": declarationPackageManifest(),
    "index.js": "export {};\n",
    ...files,
  };
}

async function compile(tree: FixtureTree): Promise<{
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
  return {
    project,
    result: await compiler.compile({ project: resolution.project }),
  };
}

function sourceTree(source: string, additional: FixtureTree = {}): FixtureTree {
  return {
    "tsconfig.json": applicationTsconfig(),
    ...additional,
    src: { "application.ts": source },
  };
}

async function compileSource(source: string, additional?: FixtureTree): Promise<CompileResult> {
  return (await compile(sourceTree(source, additional))).result;
}

async function copiedFixture(name: string): Promise<TemporaryProject> {
  const project = await copyCompilerFixture(name);
  temporaryProjects.push(project);
  return project;
}

describe("external type linking", () => {
  test("links a name declared and exported by the public declaration endpoint", async () => {
    const { result } = await compile(
      applicationTree(
        "external-contract",
        declarationPackage({ "index.d.ts": "export interface Port {}\n" }),
      ),
    );

    expect(result.status).toBe("success");
  });

  test("rejects a name missing from the public declaration endpoint", async () => {
    const { result } = await compile(
      applicationTree(
        "external-contract",
        declarationPackage({ "index.d.ts": "export interface Other {}\n" }),
      ),
    );

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics.map((item) => item.code)).toContain("TYPE_LINK_FAILED");
    }
  });

  test("rejects a name available only through a declaration re-export", async () => {
    const { result } = await compile(
      applicationTree(
        "external-contract",
        declarationPackage({
          "index.d.ts": 'export type { Port } from "./internal";\n',
          "internal.d.ts": "export interface Port {}\n",
        }),
      ),
    );

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics.map((item) => item.code)).toContain("TYPE_LINK_FAILED");
    }
  });

  test("rejects multiple local declarations exported under the same public name", async () => {
    const { result } = await compile(
      applicationTree(
        "external-contract",
        declarationPackage({
          "index.d.ts": [
            "interface Left {}",
            "interface Right {}",
            "export { Left as Port, Right as Port };",
            "",
          ].join("\n"),
        }),
      ),
    );

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics.map((item) => item.code)).toContain("TYPE_LINK_FAILED");
    }
  });
});

describe("module resolution watch inputs", () => {
  test("includes the declaration endpoint manifest and containing directory", async () => {
    const { project, result } = await compile(
      applicationTree(
        "external-contract",
        declarationPackage({ "index.d.ts": "export interface Port {}\n" }),
      ),
    );
    const packageDirectory = path.join(project.projectRoot, "node_modules", "external-contract");

    expect(result.watchInputs.fileDependencies).toContain(
      path.join(packageDirectory, "package.json"),
    );
    expect(result.watchInputs.fileDependencies).toContain(
      path.join(packageDirectory, "index.d.ts"),
    );
    expect(result.watchInputs.contextDependencies).toContain(packageDirectory);
  });

  test("includes unresolved package candidates", async () => {
    const { project, result } = await compile(applicationTree("missing-contract"));

    expect(result.status).toBe("failure");
    expect(result.watchInputs.missingDependencies).toContain(
      path.join(project.projectRoot, "node_modules"),
    );
  });

  test("includes an absent package below an existing module search directory", async () => {
    const tree = applicationTree("missing-contract");
    const { project, result } = await compile({ ...tree, node_modules: {} });

    expect(result.status).toBe("failure");
    expect(result.watchInputs.missingDependencies).toContain(
      path.join(project.projectRoot, "node_modules", "missing-contract"),
    );
  });

  test("observes a public type entry changed immediately after a compilation", async () => {
    const project = await createTemporaryProject(
      applicationTree(
        "external-contract",
        declarationPackage({
          "first.d.ts": "export interface Other {}\n",
          "index.d.ts": "export interface Other {}\n",
          "second.d.ts": "export interface Port {}\n",
        }),
      ),
    );
    temporaryProjects.push(project);
    const compiler = createCompiler();
    const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
    if (resolution.status === "failure") {
      throw new Error(JSON.stringify(resolution.diagnostics));
    }
    const first = await compiler.compile({ project: resolution.project });
    const manifest = path.join(
      project.projectRoot,
      "node_modules",
      "external-contract",
      "package.json",
    );

    await writeFile(manifest, declarationPackageManifest("./second.d.ts"));
    const second = await compiler.compile({ project: resolution.project });

    expect(first.status).toBe("failure");
    expect(second.status).toBe("success");
  });

  test("observes a missing package created immediately after a compilation", async () => {
    const project = await createTemporaryProject({
      ...applicationTree("missing-contract"),
      node_modules: {},
    });
    temporaryProjects.push(project);
    const compiler = createCompiler();
    const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
    if (resolution.status === "failure") {
      throw new Error(JSON.stringify(resolution.diagnostics));
    }
    const first = await compiler.compile({ project: resolution.project });
    const packageDirectory = path.join(project.projectRoot, "node_modules", "missing-contract");

    await mkdir(packageDirectory);
    await Promise.all([
      writeFile(path.join(packageDirectory, "package.json"), declarationPackageManifest()),
      writeFile(path.join(packageDirectory, "index.d.ts"), "export interface Port {}\n"),
      writeFile(path.join(packageDirectory, "index.js"), "export {};\n"),
    ]);
    const second = await compiler.compile({ project: resolution.project });

    expect(first.status).toBe("failure");
    expect(second.status).toBe("success");
  });
});

describe("project linking", () => {
  test("links an interface imported through a namespace export", async () => {
    const fixture = await copiedFixture("namespace-export-contract");
    const compiler = createCompiler();
    const project = await resolveProjectOrThrow(compiler, fixture.projectRoot);

    const result = await compiler.compile({ project });

    expect(result.status).toBe("success");
  });

  test("does not flatten a namespace export into named exports", async () => {
    const { result } = await compile({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "application.ts": [
          'import { Injectable } from "@reforce/context";',
          'import type { Port } from "./barrel";',
          "@Injectable()",
          "export class Consumer { constructor(readonly dependency: Port) {} }",
          "",
        ].join("\n"),
        "barrel.ts": 'export * as Ports from "./ports";\n',
        "ports.ts": "export interface Port {}\n",
      },
    });

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("TYPE_LINK_FAILED");
  });

  test("does not treat a local class in an implements clause as a provided contract", async () => {
    const result = await compileSource(
      [
        'import { Injectable } from "@reforce/context";',
        "export class BaseClass {}",
        "@Injectable() export class Implementation implements BaseClass {}",
        "@Injectable()",
        "export class Consumer { constructor(readonly dependency: BaseClass) {} }",
        "",
      ].join("\n"),
    );

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("MISSING_BEAN");
  });

  test("does not treat an external class in an implements clause as a provided contract", async () => {
    const result = await compileSource(
      [
        'import { Injectable } from "@reforce/context";',
        'import type { BaseClass } from "external-contract";',
        "@Injectable() export class Implementation implements BaseClass {}",
        "@Injectable()",
        "export class Consumer { constructor(readonly dependency: BaseClass) {} }",
        "",
      ].join("\n"),
      {
        node_modules: {
          "external-contract": declarationPackage({
            "index.d.ts": "export declare class BaseClass {}\n",
          }),
        },
      },
    );

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("MISSING_BEAN");
  });

  test("rejects type arguments applied to a non-generic provided interface", async () => {
    const result = await compileSource(
      [
        'import { Injectable } from "@reforce/context";',
        "export interface Port {}",
        "@Injectable() export class Provider implements Port<string> {}",
        "",
      ].join("\n"),
    );

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("UNSUPPORTED_GENERIC_INTERFACE");
  });

  test("rejects a generic parent of a provided application interface", async () => {
    const result = await compileSource(
      [
        'import { Injectable } from "@reforce/context";',
        "export interface Parent<T> {}",
        "export interface Port extends Parent<string> {}",
        "@Injectable() export class Provider implements Port {}",
        "",
      ].join("\n"),
    );

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("UNSUPPORTED_GENERIC_INTERFACE");
  });

  test("rejects an external parent of a provided application interface", async () => {
    const result = await compileSource(
      [
        'import { Injectable } from "@reforce/context";',
        'import type { Parent } from "external-contract";',
        "export interface Port extends Parent {}",
        "@Injectable() export class Provider implements Port {}",
        "",
      ].join("\n"),
      {
        node_modules: {
          "external-contract": declarationPackage({
            "index.d.ts": "export interface Parent {}\n",
          }),
        },
      },
    );

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("TYPE_LINK_FAILED");
  });

  test("rejects an unsupported parent of a provided application interface", async () => {
    const result = await compileSource(
      [
        'import { Injectable } from "@reforce/context";',
        "export type Parent = {};",
        "export interface Port extends Parent {}",
        "@Injectable() export class Provider implements Port {}",
        "",
      ].join("\n"),
    );

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("UNSUPPORTED_TYPE_DECLARATION");
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
    const { result } = await compile({
      "tsconfig.json": applicationTsconfig(),
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
            "export class Consumer { constructor(readonly port: Port) {} }",
            "",
          ].join("\n"),
        },
      },
    });

    expect(result.status).toBe("success");
  });

  test("rejects a package without a public type declaration endpoint", async () => {
    const result = await compileSource(
      [
        'import { Injectable } from "@reforce/context";',
        'import type { Port } from "runtime-only";',
        "@Injectable()",
        "export class Consumer { constructor(readonly port: Port) {} }",
        "",
      ].join("\n"),
      {
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
      },
    );

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("TYPE_LINK_FAILED");
  });

  test("resolves public type entries through effective custom conditions", async () => {
    const baseTree = sourceTree(
      [
        'import { Injectable } from "@reforce/context";',
        'import type { Port } from "conditioned-contract";',
        "@Injectable()",
        "export class Provider implements Port { readonly custom = true as const; }",
        "",
      ].join("\n"),
      {
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
      },
    );
    const tree: FixtureTree = {
      ...baseTree,
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
    };

    const { project, result } = await compile(tree);

    expect(result.status).toBe("success");
    expect(result.watchInputs.fileDependencies).toContain(
      path.join(project.projectRoot, "node_modules", "conditioned-contract", "custom.d.ts"),
    );
    expect(result.watchInputs.fileDependencies).not.toContain(
      path.join(project.projectRoot, "node_modules", "conditioned-contract", "default.d.ts"),
    );
  });

  test("links package exports, paths, and package imports without discovering shared Beans", async () => {
    const fixture = await copiedFixture("monorepo-application-selection");
    const target = path.join(fixture.projectRoot, "node_modules", "@fixture", "shared");
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(
      path.join(fixture.projectRoot, "packages", "shared"),
      target,
      process.platform === "win32" ? "junction" : "dir",
    );
    const appRoot = path.join(fixture.projectRoot, "apps", "api");
    const compiler = createCompiler();
    const project = await resolveProjectOrThrow(compiler, appRoot);

    const result = await compileProjectOrThrow(compiler, project);
    const manifest = result.files.find((file) => file.path === "manifest.json")?.content;

    expect(manifest).toContain('"moduleSpecifier": "@fixture/shared"');
    expect(manifest).toContain('"moduleSpecifier": "@shared/path"');
    expect(manifest).toContain('"moduleSpecifier": "#shared-contract"');
    expect(manifest).not.toContain("HiddenSharedBean");
  });
});
