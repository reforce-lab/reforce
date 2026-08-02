import { afterEach, describe, expect, test } from "bun:test";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CompilerFrontend, FrontendInput, SourceUnit } from "@reforce/compiler-spi";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { createCompiler } from "./index";

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

function applicationConfig(
  include: readonly string[] = ["src", ".reforce/generated/**/*.d.ts"],
): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ESNext",
      },
      include,
    },
    undefined,
    2,
  )}\n`;
}

async function temporaryApplication(
  files: Record<string, string> = { "application.ts": "export {};\n" },
): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    "tsconfig.json": applicationConfig(),
    src: files,
  });
  projects.push(project);
  return project;
}

function emptyUnit(input: FrontendInput): SourceUnit {
  return {
    kind: "source-unit",
    file: input.file,
    sourceKind: input.sourceKind,
    imports: [],
    exports: [],
    interfaces: [],
    namespaces: [],
    classes: [],
    beanFactories: [],
    unsupportedDeclarations: [],
  };
}

const frontend: CompilerFrontend = {
  id: "test",
  cacheKey: "test@1",
  async parse(input) {
    return { unit: emptyUnit(input), diagnostics: [] };
  },
};

test("the root entry exposes only the Compiler factory at runtime", async () => {
  const publicApi = await import("./index");

  expect(Object.keys(publicApi)).toEqual(["createCompiler"]);
});

describe("project resolution", () => {
  test("keeps a malformed leaf config in the watch dependencies", async () => {
    // Arrange
    const application = await createTemporaryProject({
      "tsconfig.json": "{\n",
    });
    projects.push(application);
    const compiler = createCompiler();
    const configPath = path.join(application.projectRoot, "tsconfig.json");

    // Act
    const result = await compiler.resolveProject({
      projectDirectory: application.projectRoot,
    });

    // Assert
    expect(result.status).toBe("failure");
    expect(result.watchInputs.fileDependencies).toContain(configPath);
    expect(result.watchInputs.contextDependencies).toContain(application.projectRoot);
  });

  test("keeps the resolved config chain when an extended config is malformed", async () => {
    // Arrange
    const application = await createTemporaryProject({
      "tsconfig.json": `${JSON.stringify({
        extends: "./tsconfig.shared.json",
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ESNext",
        },
        include: ["src", ".reforce/generated/**/*.d.ts"],
      })}\n`,
      "tsconfig.shared.json": "{\n",
      src: { "application.ts": "export {};\n" },
    });
    projects.push(application);
    const compiler = createCompiler();

    // Act
    const result = await compiler.resolveProject({
      projectDirectory: application.projectRoot,
      tsconfigPath: "tsconfig.json",
    });

    // Assert
    expect(result.status).toBe("failure");
    expect(result.watchInputs.fileDependencies).toEqual(
      expect.arrayContaining([
        path.join(application.projectRoot, "tsconfig.json"),
        path.join(application.projectRoot, "tsconfig.shared.json"),
      ]),
    );
  });

  test("watches an unresolved relative extended config as missing", async () => {
    // Arrange
    const application = await createTemporaryProject({
      "tsconfig.json": `${JSON.stringify({
        extends: "./tsconfig.shared.json",
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ESNext",
        },
        include: ["src", ".reforce/generated/**/*.d.ts"],
      })}\n`,
      src: { "application.ts": "export {};\n" },
    });
    projects.push(application);
    const compiler = createCompiler();

    // Act
    const result = await compiler.resolveProject({
      projectDirectory: application.projectRoot,
      tsconfigPath: "tsconfig.json",
    });

    // Assert
    expect(result.status).toBe("failure");
    expect(result.watchInputs.missingDependencies).toContain(
      path.join(application.projectRoot, "tsconfig.shared.json"),
    );
  });

  test("returns the direct config pattern as missing when automatic discovery finds none", async () => {
    // Arrange
    const application = await createTemporaryProject({
      src: { "application.ts": "export {};\n" },
    });
    projects.push(application);
    const compiler = createCompiler();

    // Act
    const result = await compiler.resolveProject({
      projectDirectory: application.projectRoot,
    });

    // Assert
    expect(result.status).toBe("failure");
    expect(result.watchInputs.fileDependencies).toEqual([]);
    expect(result.watchInputs.contextDependencies).toEqual([application.projectRoot]);
    expect(result.watchInputs.missingDependencies).toEqual([
      path.join(application.projectRoot, "tsconfig*.json"),
    ]);
  });

  test("automatic discovery succeeds after a matching config is created", async () => {
    // Arrange
    const application = await createTemporaryProject({
      src: { "application.ts": "export {};\n" },
    });
    projects.push(application);
    const compiler = createCompiler();
    await compiler.resolveProject({ projectDirectory: application.projectRoot });

    // Act
    await writeFile(path.join(application.projectRoot, "tsconfig.app.json"), applicationConfig());
    const result = await compiler.resolveProject({
      projectDirectory: application.projectRoot,
    });

    // Assert
    expect(result.status).toBe("success");
  });

  test("returns an absent explicit config as a missing dependency", async () => {
    // Arrange
    const application = await createTemporaryProject({
      src: { "application.ts": "export {};\n" },
    });
    projects.push(application);
    const compiler = createCompiler();
    const configPath = path.join(application.projectRoot, "tsconfig.custom.json");

    // Act
    const result = await compiler.resolveProject({
      projectDirectory: application.projectRoot,
      tsconfigPath: configPath,
    });

    // Assert
    expect(result.status).toBe("failure");
    expect(result.watchInputs.fileDependencies).toEqual([]);
    expect(result.watchInputs.missingDependencies).toEqual([configPath]);
  });

  test("explicit selection succeeds after its config is created", async () => {
    // Arrange
    const application = await createTemporaryProject({
      src: { "application.ts": "export {};\n" },
    });
    projects.push(application);
    const compiler = createCompiler();
    const configPath = path.join(application.projectRoot, "tsconfig.custom.json");
    await compiler.resolveProject({
      projectDirectory: application.projectRoot,
      tsconfigPath: configPath,
    });

    // Act
    await writeFile(configPath, applicationConfig());
    const result = await compiler.resolveProject({
      projectDirectory: application.projectRoot,
      tsconfigPath: configPath,
    });

    // Assert
    expect(result.status).toBe("success");
  });

  test("rejects an explicit config outside the selection boundary", async () => {
    const boundary = await temporaryApplication();
    const outside = await temporaryApplication();
    const compiler = createCompiler();

    const result = await compiler.resolveProject({
      projectDirectory: boundary.projectRoot,
      tsconfigPath: path.join(outside.projectRoot, "tsconfig.json"),
    });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics[0].code).toBe("PROJECT_SELECTION_OUTSIDE_BOUNDARY");
    }
  });

  test("rejects a files-only config that omits generated declarations", async () => {
    const application = await createTemporaryProject({
      src: { "application.ts": "export {};\n" },
      "tsconfig.json": `${JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ESNext",
        },
        files: ["src/application.ts"],
      })}\n`,
    });
    projects.push(application);
    const compiler = createCompiler();

    const result = await compiler.resolveProject({ projectDirectory: application.projectRoot });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics[0].code).toBe("GENERATED_DECLARATIONS_NOT_INCLUDED");
    }
  });

  test("accepts a files-only config that names the generated declaration", async () => {
    const application = await createTemporaryProject({
      src: { "application.ts": "export {};\n" },
      "tsconfig.json": `${JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ESNext",
        },
        files: ["src/application.ts", ".reforce/generated/qualifiers.d.ts"],
      })}\n`,
    });
    projects.push(application);
    const compiler = createCompiler();

    const result = await compiler.resolveProject({ projectDirectory: application.projectRoot });

    expect(result.status).toBe("success");
  });

  test("does not treat an unrelated internal output include as generated declarations", async () => {
    const application = await createTemporaryProject({
      src: { "application.ts": "export {};\n" },
      "tsconfig.json": applicationConfig(["src", ".reforce/internal"]),
    });
    projects.push(application);
    const compiler = createCompiler();

    const result = await compiler.resolveProject({ projectDirectory: application.projectRoot });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics[0].code).toBe("GENERATED_DECLARATIONS_NOT_INCLUDED");
    }
  });
});

describe("two-stage compilation", () => {
  test("rejects case-only source identities when the filesystem can materialize both files", async () => {
    // Arrange
    const application = await temporaryApplication({
      "Service.ts": "export {};\n",
      "service.ts": "export {};\n",
    });
    const upperPath = await realpath(path.join(application.projectRoot, "src", "Service.ts"));
    const lowerPath = await realpath(path.join(application.projectRoot, "src", "service.ts"));
    if (upperPath === lowerPath) {
      expect(upperPath).toBe(lowerPath);
      return;
    }
    const compiler = createCompiler();
    const resolution = await compiler.resolveProject({
      projectDirectory: application.projectRoot,
    });
    if (resolution.status === "failure") {
      throw new Error(resolution.diagnostics[0].message);
    }

    // Act
    const result = await compiler.compile({
      project: resolution.project,
      frontend,
    });

    // Assert
    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics.map((item) => item.code)).toContain("SOURCE_FILE_ID_COLLISION");
    }
  });

  test("returns the complete generated file set in memory", async () => {
    const application = await temporaryApplication();
    const compiler = createCompiler();
    const resolution = await compiler.resolveProject({
      projectDirectory: application.projectRoot,
    });
    if (resolution.status === "failure") {
      throw new Error(resolution.diagnostics[0].message);
    }

    const result = await compiler.compile({
      project: resolution.project,
      frontend,
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.files.map((file) => file.path)).toEqual([
        "beans.ts",
        "qualifiers.d.ts",
        "manifest.json",
        "bootstrap.ts",
      ]);
    }
  });

  test("rejects a project object issued by another compiler", async () => {
    const application = await temporaryApplication();
    const issuer = createCompiler();
    const resolution = await issuer.resolveProject({
      projectDirectory: application.projectRoot,
    });
    if (resolution.status === "failure") {
      throw new Error(resolution.diagnostics[0].message);
    }
    const otherCompiler = createCompiler();

    const result = await otherCompiler.compile({
      project: resolution.project,
      frontend,
    });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics[0].code).toBe("PROJECT_CONFIG_CHANGED");
    }
  });
});
