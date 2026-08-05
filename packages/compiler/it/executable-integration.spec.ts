import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundleEntry,
  resolveNodeExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterEach, expect, test } from "vitest";
import { createCompiler, type GeneratedFile } from "@/index";
import { addQualifiedSelectionProbe, createPositiveApplication } from "./support/project";

const nodeExecutable = await resolveNodeExecutable();
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

// 两个用例只在入口源码和期望 stdout 上不同：先把生成物 typecheck + bundle 起来，
// 跑通了才谈得上断言运行结果，所以前置断言留在这里（Issue #35）。
async function typecheckBuildAndRun(projectRoot: string, entryLines: readonly string[]) {
  await writeFile(path.join(projectRoot, "integration.ts"), [...entryLines, ""].join("\n"));
  await writeFile(
    path.join(projectRoot, "tsconfig.integration.json"),
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
    { cwd: projectRoot },
  );
  await bundleEntry({ entry: "integration.ts", cwd: projectRoot, outdir: "dist" });
  expect(typecheck.exitCode).toBe(0);
  expect(typecheck.stderr).toBe("");
  return await runCommand(nodeExecutable, [path.join(projectRoot, "dist", "integration.js")], {
    cwd: projectRoot,
  });
}

test("typechecks and executes the generated application definition", async () => {
  const input = await compiledApplication();
  const execution = await typecheckBuildAndRun(input.projectRoot, [
    'import { bootstrap } from "./.reforce/generated/bootstrap.js";',
    'import { GreetingService } from "./src/greeting.js";',
    "",
    "const context = await bootstrap();",
    "const greeting = context.get(GreetingService).greet();",
    "await context.close();",
    "console.log(JSON.stringify({ greeting, events: GreetingService.events }));",
  ]);
  expect(execution.exitCode).toBe(0);
  expect(execution.stdout).toBe(JSON.stringify({ greeting: "hello", events: ["start", "close"] }));
});

test("executes generated Primary, qualified, and unique provider selections", async () => {
  const input = await compiledApplication({ qualifiedSelection: true });
  const execution = await typecheckBuildAndRun(input.projectRoot, [
    'import { bootstrap } from "./.reforce/generated/bootstrap.js";',
    'import { QualifiedSelectionProbe } from "./src/qualified-selection.js";',
    "",
    "const context = await bootstrap();",
    "const values = context.get(QualifiedSelectionProbe).values();",
    "await context.close();",
    "console.log(JSON.stringify(values));",
  ]);
  expect(execution.exitCode).toBe(0);
  expect(execution.stdout).toBe(JSON.stringify(["preferred", "fallback", "unique"]));
});
