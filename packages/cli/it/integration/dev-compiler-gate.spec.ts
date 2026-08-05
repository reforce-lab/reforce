import { mkdir, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCompiler, type GeneratedFile } from "@reforce/compiler";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Compiler, CompilerWatchInputs, ResolvedProject } from "@/compiler-types";
import { DevCompilerGate } from "@/dev/compiler-gate";

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
let application: TemporaryProject | undefined;
let standaloneProject = "";

async function linkWorkspacePackage(name: string, source: string): Promise<void> {
  const target = join(standaloneProject, "node_modules", ...name.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
}

beforeAll(async () => {
  application = await createTemporaryProject({
    "package.json": `${JSON.stringify({
      name: "cli-compiler-gate-project",
      private: true,
      type: "module",
    })}\n`,
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        experimentalDecorators: false,
        emitDecoratorMetadata: false,
      },
      include: ["src", ".reforce/generated/**/*.d.ts"],
    })}\n`,
    src: {
      "application.ts": `import { Injectable } from "@reforce/context";

@Injectable()
export class ApplicationService {}
`,
    },
  });
  standaloneProject = application.projectRoot;
  await linkWorkspacePackage("@reforce/context", join(repositoryRoot, "packages", "context"));
});

afterAll(async () => {
  await application?.cleanup();
});

async function createGate() {
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: standaloneProject });
  if (resolution.status === "failure") {
    throw new Error(resolution.diagnostics[0].message);
  }
  const commits: Array<readonly GeneratedFile[]> = [];
  return {
    commits,
    gate: new DevCompilerGate({
      compiler,
      projectDirectory: standaloneProject,
      project: resolution.project,
      initialWatchInputs: resolution.watchInputs,
      generatedOutput: {
        async commitGenerated(files) {
          commits.push(files);
        },
      },
    }),
  };
}

function createCompilerGate(options: {
  compiler: Compiler;
  project: ResolvedProject;
  initialWatchInputs: CompilerWatchInputs;
}): DevCompilerGate {
  return new DevCompilerGate({
    ...options,
    projectDirectory: standaloneProject,
    generatedOutput: {
      async commitGenerated() {},
    },
  });
}

describe("development compiler gate", () => {
  test("commits generated output before reporting a successful initial compilation", async () => {
    const { gate, commits } = await createGate();

    const result = await gate.initialize();

    expect(result.status).toBe("success");
    expect(commits).toHaveLength(1);
    expect(commits[0]?.map((file) => file.path)).toEqual([
      "beans.ts",
      "qualifiers.d.ts",
      "manifest.json",
      "bootstrap.ts",
      "routes.json",
      "routes.ts",
      "weaving.json",
    ]);
  });

  test("registers source and config dependencies without watching generated commits", async () => {
    const { gate } = await createGate();

    const result = await gate.initialize();

    expect(result.watchInputs.fileDependencies).toContain(
      resolve(standaloneProject, "src/application.ts"),
    );
    expect(result.watchInputs.fileDependencies).toContain(
      resolve(standaloneProject, "tsconfig.json"),
    );
    expect(
      [
        ...result.watchInputs.fileDependencies,
        ...result.watchInputs.contextDependencies,
        ...result.watchInputs.missingDependencies,
      ].some((path) => path.includes(".reforce")),
    ).toBe(false);
  });

  test("re-resolves the application before every later compilation", async () => {
    const { gate, commits } = await createGate();
    await gate.initialize();
    gate.takeInitialResult();

    const result = await gate.compileNext();

    expect(result.status).toBe("success");
    expect(commits).toHaveLength(2);
  });

  test("keeps the known config and source watches when project resolution throws", async () => {
    const compiler = createCompiler();
    const resolution = await compiler.resolveProject({ projectDirectory: standaloneProject });
    if (resolution.status === "failure") {
      throw new Error(resolution.diagnostics[0].message);
    }
    const resolutionError = new Error("resolution failed unexpectedly");
    const throwingCompiler: Compiler = {
      ...compiler,
      compile: (request) => compiler.compile(request),
      async resolveProject() {
        throw resolutionError;
      },
    };
    const gate = createCompilerGate({
      compiler: throwingCompiler,
      project: resolution.project,
      initialWatchInputs: resolution.watchInputs,
    });
    await gate.initialize();

    const result = await gate.compileNext();

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("Expected project resolution to fail unexpectedly.");
    }
    expect(result.error).toBe(resolutionError);
    expect(result.watchInputs.fileDependencies).toContain(
      resolve(standaloneProject, "tsconfig.json"),
    );
    expect(result.watchInputs.fileDependencies).toContain(
      resolve(standaloneProject, "src/application.ts"),
    );
  });

  test("keeps the previous stable watches when a later compilation throws", async () => {
    const compiler = createCompiler();
    const resolution = await compiler.resolveProject({ projectDirectory: standaloneProject });
    if (resolution.status === "failure") {
      throw new Error(resolution.diagnostics[0].message);
    }
    const stableDependency = resolve(standaloneProject, "src/stable-dependency.ts");
    const compilationError = new Error("compilation failed unexpectedly");
    let compileCount = 0;
    const throwingCompiler: Compiler = {
      ...compiler,
      resolveProject: (request) => compiler.resolveProject(request),
      async compile(request) {
        compileCount += 1;
        if (compileCount > 1) {
          throw compilationError;
        }
        const result = await compiler.compile(request);
        return {
          ...result,
          watchInputs: {
            ...result.watchInputs,
            fileDependencies: [...result.watchInputs.fileDependencies, stableDependency],
          },
        };
      },
    };
    const gate = createCompilerGate({
      compiler: throwingCompiler,
      project: resolution.project,
      initialWatchInputs: resolution.watchInputs,
    });
    await gate.initialize();

    const result = await gate.compileNext();

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("Expected compilation to fail unexpectedly.");
    }
    expect(result.error).toBe(compilationError);
    expect(result.watchInputs.fileDependencies).toContain(stableDependency);
  });
});
