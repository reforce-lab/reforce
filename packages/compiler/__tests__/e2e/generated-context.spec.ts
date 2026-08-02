import { afterEach, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { yukuFrontend } from "@reforce/compiler-yuku";
import {
  copyFixtureTree,
  createTemporaryProject,
  resolveNodeExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { createCompiler, type GeneratedFile } from "#internal/index";

const fixtureDirectory = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const nodeExecutable = await resolveNodeExecutable();
const temporaryProjects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

async function compiledFixture(name: string): Promise<TemporaryProject> {
  const temporary = await createTemporaryProject();
  temporaryProjects.push(temporary);
  await copyFixtureTree(path.join(fixtureDirectory, name, "project"), temporary.projectRoot);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: temporary.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  const compilation = await compiler.compile({
    project: resolution.project,
    frontend: yukuFrontend,
  });
  if (compilation.status === "failure") {
    throw new Error(JSON.stringify(compilation.diagnostics));
  }
  await writeGeneratedFiles(temporary.projectRoot, compilation.files);
  await linkContextPackage(temporary.projectRoot);
  return temporary;
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

async function linkContextPackage(projectRoot: string): Promise<void> {
  const target = path.join(projectRoot, "node_modules", "@reforce", "context");
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(
    path.join(repositoryRoot, "packages", "context"),
    target,
    process.platform === "win32" ? "junction" : "dir",
  );
}

test("typechecks and executes the generated application definition", async () => {
  const fixture = await compiledFixture("standalone-application");
  await writeFile(
    path.join(fixture.projectRoot, "integration.ts"),
    [
      'import { bootstrap } from "./.reforce/generated/bootstrap.js";',
      'import { GreetingService } from "./src/application.js";',
      "",
      "const context = await bootstrap();",
      "const greeting = context.get(GreetingService).greet();",
      "await context.close();",
      "console.log(JSON.stringify({ greeting, events: GreetingService.events }));",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(fixture.projectRoot, "tsconfig.integration.json"),
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
    { cwd: fixture.projectRoot },
  );
  const build = await runCommand(
    process.execPath,
    [
      "build",
      "integration.ts",
      "--target=node",
      "--format=esm",
      "--outdir=dist",
      "--conditions=development",
    ],
    { cwd: fixture.projectRoot },
  );

  expect(typecheck.exitCode).toBe(0);
  expect(typecheck.stderr).toBe("");
  expect(build.exitCode).toBe(0);
  const execution = await runCommand(
    nodeExecutable,
    [path.join(fixture.projectRoot, "dist", "integration.js")],
    { cwd: fixture.projectRoot },
  );
  expect(execution.exitCode).toBe(0);
  expect(execution.stdout).toBe(JSON.stringify({ greeting: "hello", events: ["start", "close"] }));
});

test("executes generated Primary, qualified, and unique provider selections", async () => {
  const fixture = await compiledFixture("provider-selection-runtime");
  await writeFile(
    path.join(fixture.projectRoot, "integration.ts"),
    [
      'import { bootstrap } from "./.reforce/generated/bootstrap.js";',
      'import { SelectionProbe } from "./src/application.js";',
      "",
      "const context = await bootstrap();",
      "const values = context.get(SelectionProbe).values();",
      "await context.close();",
      "console.log(JSON.stringify(values));",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(fixture.projectRoot, "tsconfig.integration.json"),
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
    { cwd: fixture.projectRoot },
  );
  const build = await runCommand(
    process.execPath,
    [
      "build",
      "integration.ts",
      "--target=node",
      "--format=esm",
      "--outdir=dist",
      "--conditions=development",
    ],
    { cwd: fixture.projectRoot },
  );

  expect(typecheck.exitCode).toBe(0);
  expect(typecheck.stderr).toBe("");
  expect(build.exitCode).toBe(0);
  const execution = await runCommand(
    nodeExecutable,
    [path.join(fixture.projectRoot, "dist", "integration.js")],
    { cwd: fixture.projectRoot },
  );
  expect(execution.exitCode).toBe(0);
  expect(execution.stdout).toBe(JSON.stringify(["preferred", "fallback", "unique"]));
});
