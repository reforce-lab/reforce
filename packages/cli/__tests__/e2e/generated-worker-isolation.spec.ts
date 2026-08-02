import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCompiler, type GeneratedFile } from "@reforce/compiler";
import {
  copyFixtureTree,
  createTemporaryProject,
  resolveBunExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";

const fixtureRoot = fileURLToPath(
  new URL("../../fixtures/worker/generated-application", import.meta.url),
);
const contextRoot = fileURLToPath(new URL("../../../context", import.meta.url));
const commandTimeout = 120_000;
let temporaryProject: TemporaryProject | undefined;
let builtWorkerEntry: string | undefined;
let workerHarness: string | undefined;
let bunExecutable: string | undefined;

function commandFailure(result: { readonly stderr?: unknown; readonly stdout?: unknown }): string {
  return `stdout:\n${String(result.stdout)}\nstderr:\n${String(result.stderr)}`;
}

async function writeGeneratedFiles(
  projectRoot: string,
  files: readonly GeneratedFile[],
): Promise<void> {
  const generatedDirectory = join(projectRoot, ".reforce", "generated");
  await mkdir(generatedDirectory, { recursive: true });
  await Promise.all(
    files.map((file) => writeFile(join(generatedDirectory, file.path), file.content)),
  );
}

async function runBuiltWorkers(): Promise<unknown> {
  if (
    temporaryProject === undefined ||
    builtWorkerEntry === undefined ||
    workerHarness === undefined ||
    bunExecutable === undefined
  ) {
    throw new Error("Generated application Worker fixture has not been built.");
  }
  const result = await runCommand(bunExecutable, [workerHarness, builtWorkerEntry], {
    cwd: temporaryProject.projectRoot,
    timeout: commandTimeout,
  });
  if (result.exitCode !== 0) {
    throw new Error(commandFailure(result));
  }
  if (typeof result.stdout !== "string") {
    throw new Error("Generated application Workers did not produce text output.");
  }
  return JSON.parse(result.stdout);
}

beforeAll(async () => {
  temporaryProject = await createTemporaryProject();
  await copyFixtureTree(fixtureRoot, temporaryProject.projectRoot);
  const scopeRoot = join(temporaryProject.projectRoot, "node_modules", "@reforce");
  await mkdir(scopeRoot, { recursive: true });
  await symlink(
    contextRoot,
    join(scopeRoot, "context"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const applicationRoot = join(temporaryProject.projectRoot, "project");
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: applicationRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  const compilation = await compiler.compile({ project: resolution.project });
  if (compilation.status === "failure") {
    throw new Error(JSON.stringify(compilation.diagnostics));
  }
  await writeGeneratedFiles(applicationRoot, compilation.files);

  builtWorkerEntry = join(temporaryProject.projectRoot, "dist", "worker-entry.mjs");
  workerHarness = join(temporaryProject.projectRoot, "worker-harness.mjs");
  bunExecutable = await resolveBunExecutable();
  const build = await runCommand(
    process.execPath,
    [
      "build",
      "worker-entry.mjs",
      "--target=node",
      "--format=esm",
      `--outfile=${builtWorkerEntry}`,
      "--conditions=development",
    ],
    { cwd: temporaryProject.projectRoot, timeout: commandTimeout },
  );
  if (build.exitCode !== 0) {
    throw new Error(commandFailure(build));
  }
}, commandTimeout);

afterAll(async () => {
  await temporaryProject?.cleanup();
});

test("keeps generated singleton state isolated in each Bun Worker", async () => {
  const observations = await runBuiltWorkers();

  expect(observations).toMatchObject([
    { label: "first", singleton: true, alphaMarker: 1 },
    { label: "second", singleton: true, alphaMarker: 1 },
  ]);
});

test("keeps generated cycle proxy state isolated in each Bun Worker", async () => {
  const observations = await runBuiltWorkers();

  expect(observations).toMatchObject([
    { label: "first", cycleProxyDistinct: true, cycleProxyMarker: 1 },
    { label: "second", cycleProxyDistinct: true, cycleProxyMarker: 1 },
  ]);
});

test("keeps generated Lazy state isolated in each Bun Worker", async () => {
  const observations = await runBuiltWorkers();

  expect(observations).toMatchObject([
    {
      label: "first",
      lazySingleton: true,
      resourceMarker: 1,
      beforeClose: { resourceCreations: 1 },
    },
    {
      label: "second",
      lazySingleton: true,
      resourceMarker: 1,
      beforeClose: { resourceCreations: 1 },
    },
  ]);
});

test("runs generated lifecycle and disposer cleanup once per Bun Worker", async () => {
  const observations = await runBuiltWorkers();

  expect(observations).toMatchObject([
    {
      beforeClose: { starts: 1, closes: 0, resourceDisposals: 0 },
      afterClose: { starts: 1, closes: 1, resourceDisposals: 1 },
    },
    {
      beforeClose: { starts: 1, closes: 0, resourceDisposals: 0 },
      afterClose: { starts: 1, closes: 1, resourceDisposals: 1 },
    },
  ]);
});
