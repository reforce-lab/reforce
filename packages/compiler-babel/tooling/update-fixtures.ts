import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CompilerDiagnostic, GeneratedFile } from "@reforce/compiler";
import { createCompiler } from "@reforce/compiler";
import type { FrontendDiagnostic, SourceUnit } from "@reforce/compiler-spi";
import { yukuFrontend } from "@reforce/compiler-yuku";
import { babelFrontend } from "#internal/frontend";
import { fixtureDirectory, fixtureNames, loadFrontendInputs } from "#tooling/fixture-corpus";

const generatedPaths = ["beans.ts", "qualifiers.d.ts", "manifest.json", "bootstrap.ts"] as const;

function json(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

function normalizeProjectPaths(value: unknown, projectRoot: string): unknown {
  if (typeof value === "string") {
    const replaced = value.split(projectRoot).join("<projectRoot>");
    return replaced.includes("<projectRoot>") ? replaced.split(path.sep).join("/") : replaced;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeProjectPaths(item, projectRoot));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizeProjectPaths(item, projectRoot)]),
  );
}

async function frontendGoldens(name: string): Promise<{
  readonly units: readonly SourceUnit[];
  readonly diagnostics: readonly FrontendDiagnostic[];
}> {
  const inputs = await loadFrontendInputs(name);
  const [babelResults, yukuResults] = await Promise.all([
    Promise.all(inputs.map((input) => babelFrontend.parse(input))),
    Promise.all(inputs.map((input) => yukuFrontend.parse(input))),
  ]);
  if (!isDeepStrictEqual(babelResults, yukuResults)) {
    throw new Error(`Frontend adapters disagree for ${name}`);
  }
  return {
    units: babelResults.flatMap((result) => (result.unit === undefined ? [] : [result.unit])),
    diagnostics: babelResults.flatMap((result) => result.diagnostics),
  };
}

async function hasDirectTsconfig(projectDirectory: string): Promise<boolean> {
  return (await readdir(projectDirectory)).some((name) => /^tsconfig.*\.json$/u.test(name));
}

async function compilerGoldens(projectDirectory: string): Promise<{
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly files: readonly GeneratedFile[];
}> {
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory });
  if (resolution.status === "failure") {
    return { diagnostics: resolution.diagnostics, files: [] };
  }
  const result = await compiler.compile({ project: resolution.project, frontend: yukuFrontend });
  return result.status === "success"
    ? { diagnostics: result.diagnostics, files: result.files }
    : { diagnostics: result.diagnostics, files: [] };
}

async function writeGenerated(
  expectedDirectory: string,
  files: readonly GeneratedFile[],
): Promise<void> {
  const generatedDirectory = path.join(expectedDirectory, "generated");
  await rm(generatedDirectory, { recursive: true, force: true });
  if (files.length === 0) {
    return;
  }
  if (
    files.length !== generatedPaths.length ||
    generatedPaths.some((expectedPath, index) => files[index]?.path !== expectedPath)
  ) {
    throw new Error("Compiler returned an unexpected generated file set");
  }
  await mkdir(generatedDirectory, { recursive: true });
  await Promise.all(
    files.map((file) => writeFile(path.join(generatedDirectory, file.path), file.content)),
  );
}

async function updateCase(name: string): Promise<void> {
  const caseDirectory = path.join(fixtureDirectory, name);
  const projectDirectory = path.join(caseDirectory, "project");
  const expectedDirectory = path.join(caseDirectory, "expected");
  const frontend = await frontendGoldens(name);
  await mkdir(expectedDirectory, { recursive: true });
  const sourceIrPath = path.join(expectedDirectory, "source-ir.json");
  if (frontend.units.length === 0) {
    await rm(sourceIrPath, { force: true });
  } else {
    await writeFile(sourceIrPath, json(frontend.units));
  }
  if (!(await hasDirectTsconfig(projectDirectory))) {
    await writeFile(path.join(expectedDirectory, "diagnostics.json"), json(frontend.diagnostics));
    await writeGenerated(expectedDirectory, []);
    return;
  }
  const compiler = await compilerGoldens(projectDirectory);
  await writeFile(
    path.join(expectedDirectory, "diagnostics.json"),
    json(normalizeProjectPaths(compiler.diagnostics, projectDirectory)),
  );
  await writeGenerated(expectedDirectory, compiler.files);
}

for (const name of await fixtureNames()) {
  await updateCase(name);
}
