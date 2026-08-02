import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBunExecutable, runCommand, type TemporaryProject } from "@reforce/tooling-testing";
import { createCompiler, type GeneratedFile } from "@/index";
import { addQualifiedSelectionProbe, createPositiveApplication } from "./support/project";

const bunExecutable = await resolveBunExecutable();
const temporaryProjects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});
async function compiledApplication(options: { qualifiedSelection?: boolean } = {}) {
  const temporary = await createPositiveApplication();
  temporaryProjects.push(temporary);
  if (options.qualifiedSelection === true) {
    await addQualifiedSelectionProbe(temporary.projectRoot);
  }
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: temporary.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  const compilation = await compiler.compile({ project: resolution.project });
  if (compilation.status === "failure") {
    throw new Error(JSON.stringify(compilation.diagnostics));
  }
  await writeGeneratedFiles(temporary.projectRoot, compilation.files);
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

test("typechecks and executes the generated application definition", async () => {
  const input = await compiledApplication();
  await writeFile(
    path.join(input.projectRoot, "integration.ts"),
    [
      'import { bootstrap } from "./.reforce/generated/bootstrap.js";',
      'import { GreetingService } from "./src/greeting.js";',
      "",
      "const context = await bootstrap();",
      "const greeting = context.get(GreetingService).greet();",
      "await context.close();",
      "console.log(JSON.stringify({ greeting, events: GreetingService.events }));",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(input.projectRoot, "tsconfig.integration.json"),
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
    { cwd: input.projectRoot },
  );
  const build = await runCommand(
    process.execPath,
    ["build", "integration.ts", "--target=node", "--format=esm", "--outdir=dist"],
    { cwd: input.projectRoot },
  );

  expect(typecheck.exitCode).toBe(0);
  expect(typecheck.stderr).toBe("");
  expect(build.exitCode).toBe(0);
  const execution = await runCommand(
    bunExecutable,
    [path.join(input.projectRoot, "dist", "integration.js")],
    { cwd: input.projectRoot },
  );
  expect(execution.exitCode).toBe(0);
  expect(execution.stdout).toBe(JSON.stringify({ greeting: "hello", events: ["start", "close"] }));
});

test("executes generated Primary, qualified, and unique provider selections", async () => {
  const input = await compiledApplication({ qualifiedSelection: true });
  await writeFile(
    path.join(input.projectRoot, "integration.ts"),
    [
      'import { bootstrap } from "./.reforce/generated/bootstrap.js";',
      'import { QualifiedSelectionProbe } from "./src/qualified-selection.js";',
      "",
      "const context = await bootstrap();",
      "const values = context.get(QualifiedSelectionProbe).values();",
      "await context.close();",
      "console.log(JSON.stringify(values));",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(input.projectRoot, "tsconfig.integration.json"),
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
    { cwd: input.projectRoot },
  );
  const build = await runCommand(
    process.execPath,
    ["build", "integration.ts", "--target=node", "--format=esm", "--outdir=dist"],
    { cwd: input.projectRoot },
  );

  expect(typecheck.exitCode).toBe(0);
  expect(typecheck.stderr).toBe("");
  expect(build.exitCode).toBe(0);
  const execution = await runCommand(
    bunExecutable,
    [path.join(input.projectRoot, "dist", "integration.js")],
    { cwd: input.projectRoot },
  );
  expect(execution.exitCode).toBe(0);
  expect(execution.stdout).toBe(JSON.stringify(["preferred", "fallback", "unique"]));
});
