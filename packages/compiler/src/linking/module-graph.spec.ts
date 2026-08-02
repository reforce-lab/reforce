import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { yukuFrontend } from "@reforce/compiler-yuku";
import {
  createTemporaryProject,
  type FixtureTree,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { type CompileResult, createCompiler } from "#internal/index";

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
    result: await compiler.compile({ project: resolution.project, frontend: yukuFrontend }),
  };
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
    const first = await compiler.compile({ project: resolution.project, frontend: yukuFrontend });
    const manifest = path.join(
      project.projectRoot,
      "node_modules",
      "external-contract",
      "package.json",
    );

    await writeFile(manifest, declarationPackageManifest("./second.d.ts"));
    const second = await compiler.compile({ project: resolution.project, frontend: yukuFrontend });

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
    const first = await compiler.compile({ project: resolution.project, frontend: yukuFrontend });
    const packageDirectory = path.join(project.projectRoot, "node_modules", "missing-contract");

    await mkdir(packageDirectory);
    await Promise.all([
      writeFile(path.join(packageDirectory, "package.json"), declarationPackageManifest()),
      writeFile(path.join(packageDirectory, "index.d.ts"), "export interface Port {}\n"),
      writeFile(path.join(packageDirectory, "index.js"), "export {};\n"),
    ]);
    const second = await compiler.compile({ project: resolution.project, frontend: yukuFrontend });

    expect(first.status).toBe("failure");
    expect(second.status).toBe("success");
  });
});
