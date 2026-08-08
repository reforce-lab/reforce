import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createTemporaryProject,
  type ProjectTree,
  type TemporaryProject,
  writeProjectTree,
} from "@reforce/tooling-testing";
import { afterEach, describe, expect, test } from "vitest";
import { createCompiler } from "@/index";
import {
  type CompilerProjectName,
  createCompilerProject,
  createPositiveApplication,
  resolveProjectOrThrow,
  writePositiveApplication,
} from "./support/project";

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});
function applicationConfig(
  include: readonly string[] = ["src", ".reforce/generated/**/*.ts"],
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

// `files` 形式的 tsconfig 与 applicationConfig 的 `include` 形式走不同的覆盖判定分支，
// 两个用例只差 files 列表本身。
function filesConfig(files: readonly string[]): string {
  return `${JSON.stringify({
    compilerOptions: {
      module: "ESNext",
      moduleResolution: "Bundler",
      target: "ESNext",
    },
    files,
  })}\n`;
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

async function copiedProject(name: CompilerProjectName): Promise<TemporaryProject> {
  const project = await createCompilerProject(name);
  projects.push(project);
  return project;
}

async function positiveApplication(): Promise<TemporaryProject> {
  const project = await createPositiveApplication();
  projects.push(project);
  return project;
}

async function createDirectoryLink(source: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
}

async function createApplications(): Promise<TemporaryProject> {
  const temporary = await createTemporaryProject();
  projects.push(temporary);
  await writeProjectTree(temporary.projectRoot, {
    "app-a": {
      src: { "application.ts": "export class ApplicationA {}\n" },
      "tsconfig.json": applicationConfig(),
    },
    "app-b": {
      src: { "application.ts": "export class ApplicationB {}\n" },
      "tsconfig.json": applicationConfig(),
    },
  } satisfies ProjectTree);
  return temporary;
}

async function replaceDirectoryLink(link: string, target: string): Promise<void> {
  await rm(link, { force: true, recursive: true });
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

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
        include: ["src", ".reforce/generated/**/*.ts"],
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
        include: ["src", ".reforce/generated/**/*.ts"],
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

  test("rejects a files-only config that omits the generated output", async () => {
    const application = await createTemporaryProject({
      src: { "application.ts": "export {};\n" },
      "tsconfig.json": filesConfig(["src/application.ts"]),
    });
    projects.push(application);
    const compiler = createCompiler();

    const result = await compiler.resolveProject({ projectDirectory: application.projectRoot });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics[0].code).toBe("GENERATED_DECLARATIONS_NOT_INCLUDED");
    }
  });

  test("rejects a config that names only the generated declarations", async () => {
    // 生成的 .ts 也必须进用户的编译单元（#350）：只收 .d.ts 时 beans.ts 里 emit 的
    // `new Target(...)` 不进类型检查，实参个数对不上也不会有人报错。
    const application = await createTemporaryProject({
      src: { "application.ts": "export {};\n" },
      "tsconfig.json": filesConfig(["src/application.ts", ".reforce/generated/qualifiers.d.ts"]),
    });
    projects.push(application);
    const compiler = createCompiler();

    const result = await compiler.resolveProject({ projectDirectory: application.projectRoot });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.diagnostics[0].code).toBe("GENERATED_DECLARATIONS_NOT_INCLUDED");
    }
  });

  test("accepts a files-only config that names both generated halves", async () => {
    const application = await createTemporaryProject({
      src: { "application.ts": "export {};\n" },
      "tsconfig.json": filesConfig([
        "src/application.ts",
        ".reforce/generated/qualifiers.d.ts",
        ".reforce/generated/beans.ts",
      ]),
    });
    projects.push(application);
    const compiler = createCompiler();

    const result = await compiler.resolveProject({ projectDirectory: application.projectRoot });

    expect(result.status).toBe("success");
  });

  test("does not treat an unrelated internal output include as the generated output", async () => {
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

  test("resolves a standalone application from its own directory", async () => {
    const input = await positiveApplication();
    const compiler = createCompiler();

    const project = await resolveProjectOrThrow(compiler, input.projectRoot);

    expect(project.projectRoot).toBe(input.projectRoot);
    expect(project.tsconfigPath).toBe(path.join(input.projectRoot, "tsconfig.json"));
  });

  test("resolves a monorepo application from the application directory", async () => {
    const input = await copiedProject("monorepo-application-selection");
    const appDirectory = path.join(input.projectRoot, "apps", "api");
    const compiler = createCompiler();

    const project = await resolveProjectOrThrow(compiler, appDirectory);

    expect(project.projectRoot).toBe(appDirectory);
  });

  test("selects a nested config explicitly from a monorepo root", async () => {
    const input = await copiedProject("monorepo-application-selection");
    const compiler = createCompiler();

    const project = await resolveProjectOrThrow(
      compiler,
      input.projectRoot,
      path.join("apps", "api", "tsconfig.json"),
    );

    expect(project.projectRoot).toBe(path.join(input.projectRoot, "apps", "api"));
  });

  test("does not descend from a solution config into referenced applications", async () => {
    const input = await copiedProject("monorepo-application-selection");
    const compiler = createCompiler();

    const result = await compiler.resolveProject({ projectDirectory: input.projectRoot });

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "PROJECT_CONFIG_NOT_FOUND",
    ]);
  });

  test("reports every valid direct config when automatic selection is ambiguous", async () => {
    const input = await copiedProject("ambiguous-leaf-config");
    const compiler = createCompiler();

    const result = await compiler.resolveProject({ projectDirectory: input.projectRoot });

    expect(result.status).toBe("failure");
    expect(result.diagnostics[0]?.code).toBe("UNSUPPORTED_PROJECT_CONFIG");
    expect(result.diagnostics[0]?.related.map((item) => item.message)).toEqual([
      path.join(input.projectRoot, "tsconfig.app.json"),
      path.join(input.projectRoot, "tsconfig.worker.json"),
    ]);
  });

  test("selects one direct config when the ambiguous application is explicit", async () => {
    const input = await copiedProject("ambiguous-leaf-config");
    const compiler = createCompiler();

    const project = await resolveProjectOrThrow(
      compiler,
      input.projectRoot,
      "tsconfig.worker.json",
    );

    expect(project.tsconfigPath).toBe(path.join(input.projectRoot, "tsconfig.worker.json"));
  });

  test("canonicalizes symlink, parent-segment, and case-only aliases", async () => {
    const container = await createTemporaryProject();
    projects.push(container);
    const applicationDirectory = path.join(container.projectRoot, "real", "app");
    await mkdir(applicationDirectory, { recursive: true });
    await writePositiveApplication(applicationDirectory);
    const alias = path.join(container.projectRoot, "Application");
    const caseAlias = path.join(container.projectRoot, "application");
    await createDirectoryLink(applicationDirectory, alias);
    try {
      await realpath(caseAlias);
    } catch {
      await createDirectoryLink(applicationDirectory, caseAlias);
    }
    const compiler = createCompiler();

    const direct = await resolveProjectOrThrow(compiler, applicationDirectory);
    const aliased = await resolveProjectOrThrow(
      compiler,
      path.join(container.projectRoot, "real", "..", "Application"),
    );
    const caseAliased = await resolveProjectOrThrow(compiler, caseAlias);

    expect(aliased).toEqual(direct);
    expect(caseAliased).toEqual(direct);
  });

  test("rejects an application source included from outside the project root", async () => {
    const input = await createTemporaryProject({
      apps: {
        api: {
          src: { "application.ts": "export class ApplicationService {}\n" },
          "tsconfig.json": applicationConfig([
            "src",
            "../../shared.ts",
            ".reforce/generated/**/*.ts",
          ]),
        },
      },
      "shared.ts": "export interface SharedContract {}\n",
    });
    projects.push(input);
    const compiler = createCompiler();

    const result = await compiler.resolveProject({
      projectDirectory: path.join(input.projectRoot, "apps", "api"),
    });

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "SOURCE_OUTSIDE_PROJECT_ROOT",
    ]);
  });

  test("watches a shared config extended from outside the application root", async () => {
    const input = await copiedProject("monorepo-application-selection");
    const appRoot = path.join(input.projectRoot, "apps", "api");
    const compiler = createCompiler();

    const result = await compiler.resolveProject({ projectDirectory: appRoot });

    expect(result.status).toBe("success");
    expect(result.watchInputs.fileDependencies).toContain(
      path.join(input.projectRoot, "tsconfig.shared.json"),
    );
  });

  test("returns no generated files after the resolved config is replaced", async () => {
    const input = await positiveApplication();
    const compiler = createCompiler();
    const project = await resolveProjectOrThrow(compiler, input.projectRoot);
    const configPath = path.join(input.projectRoot, "tsconfig.json");
    const replacementPath = path.join(input.projectRoot, "tsconfig.replacement.json");
    const backupPath = path.join(input.projectRoot, "tsconfig.original.json");
    const config = await readFile(configPath, "utf8");
    await writeFile(replacementPath, config.replace('"strict": true', '"strict": false'));
    await rename(configPath, backupPath);
    await rename(replacementPath, configPath);

    const result = await compiler.compile({ project });

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "PROJECT_CONFIG_CHANGED",
    ]);
    expect("files" in result).toBe(false);
  });

  test("compile rejects a project directory link retargeted after resolution", async () => {
    const temporary = await createApplications();
    const first = path.join(temporary.projectRoot, "app-a");
    const second = path.join(temporary.projectRoot, "app-b");
    const selected = path.join(temporary.projectRoot, "selected-app");
    await symlink(first, selected, process.platform === "win32" ? "junction" : "dir");
    const compiler = createCompiler();
    const project = await resolveProjectOrThrow(compiler, selected);

    await replaceDirectoryLink(selected, second);
    const result = await compiler.compile({ project });

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "PROJECT_CONFIG_CHANGED",
    ]);
  });

  test("compile rejects an explicit config link retargeted after resolution", async () => {
    const temporary = await createApplications();
    const first = path.join(temporary.projectRoot, "app-a");
    const second = path.join(temporary.projectRoot, "app-b");
    const selected = path.join(temporary.projectRoot, "selected-config");
    await symlink(first, selected, process.platform === "win32" ? "junction" : "dir");
    const compiler = createCompiler();
    const project = await resolveProjectOrThrow(
      compiler,
      temporary.projectRoot,
      path.join(selected, "tsconfig.json"),
    );

    await replaceDirectoryLink(selected, second);
    const result = await compiler.compile({ project });

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "PROJECT_CONFIG_CHANGED",
    ]);
  });
});
