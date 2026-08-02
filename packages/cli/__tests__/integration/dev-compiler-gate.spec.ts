import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createCompiler, type GeneratedFile } from "@reforce/compiler";
import type { Compiler, CompilerWatchInputs, ResolvedProject } from "../../src/compiler-types";
import { DevCompilerGate } from "../../src/dev-compiler-gate";

const standaloneProject = resolve("../compiler/fixtures/standalone-application/project");

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
