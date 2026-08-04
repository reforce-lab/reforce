import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyApplicationProject,
  createTemporaryProject,
  resolveBunExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";

const e2eRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const workerSupportRoot = join(e2eRoot, "support", "worker");
const applicationFixture = join(e2eRoot, "fixtures", "application");
const cliEntry = join(workspaceRoot, "packages", "cli", "dist", "reforce.js");
const contextRoot = join(workspaceRoot, "packages", "context");
const configRoot = join(workspaceRoot, "packages", "config");
const toolingTsconfigRoot = join(workspaceRoot, "tooling", "tsconfig");
const bunTypesRoot = fileURLToPath(new URL(".", import.meta.resolve("@types/bun/package.json")));
const radashiRoot = fileURLToPath(new URL("..", import.meta.resolve("radashi")));
const commandTimeout = 120_000;
let temporaryProject: TemporaryProject | undefined;
let builtWorkerEntry: string | undefined;
let workerHarness: string | undefined;
let bunExecutable: string | undefined;

function commandFailure(result: { readonly stderr?: unknown; readonly stdout?: unknown }): string {
  return `stdout:\n${String(result.stdout)}\nstderr:\n${String(result.stderr)}`;
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
  await Promise.all([
    cp(
      join(workerSupportRoot, "worker-entry.ts"),
      join(temporaryProject.projectRoot, "worker-entry.ts"),
    ),
    cp(
      join(workerSupportRoot, "worker-harness.ts"),
      join(temporaryProject.projectRoot, "worker-harness.ts"),
    ),
  ]);
  const scopeRoot = join(temporaryProject.projectRoot, "node_modules", "@reforce");
  const typesScopeRoot = join(temporaryProject.projectRoot, "node_modules", "@types");
  const contextTarget = join(scopeRoot, "context");
  await Promise.all([
    mkdir(contextTarget, { recursive: true }),
    mkdir(typesScopeRoot, { recursive: true }),
  ]);
  await Promise.all([
    cp(join(contextRoot, "package.json"), join(contextTarget, "package.json")),
    cp(join(contextRoot, "dist"), join(contextTarget, "dist"), { recursive: true }),
    cp(radashiRoot, join(temporaryProject.projectRoot, "node_modules", "radashi"), {
      recursive: true,
    }),
    symlink(
      toolingTsconfigRoot,
      join(scopeRoot, "tooling-tsconfig"),
      process.platform === "win32" ? "junction" : "dir",
    ),
    // fixture 应用带 config class：workspace 符号链接保留包内 node_modules，dotenv 可解析。
    symlink(
      configRoot,
      join(scopeRoot, "config"),
      process.platform === "win32" ? "junction" : "dir",
    ),
    symlink(
      bunTypesRoot,
      join(typesScopeRoot, "bun"),
      process.platform === "win32" ? "junction" : "dir",
    ),
  ]);

  const applicationRoot = join(temporaryProject.projectRoot, "project");
  await copyApplicationProject(applicationFixture, applicationRoot);
  const compilation = await runCommand(
    process.execPath,
    [cliEntry, "build", "--project", applicationRoot],
    { cwd: applicationRoot, timeout: commandTimeout },
  );
  if (compilation.exitCode !== 0) {
    throw new Error(commandFailure(compilation));
  }

  builtWorkerEntry = join(temporaryProject.projectRoot, "dist", "worker-entry.mjs");
  workerHarness = join(temporaryProject.projectRoot, "worker-harness.ts");
  bunExecutable = await resolveBunExecutable();
  const build = await runCommand(
    process.execPath,
    ["build", "worker-entry.ts", "--target=node", "--format=esm", `--outfile=${builtWorkerEntry}`],
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

test("resolves GreetingService behavior in each Bun Worker", async () => {
  const observations = await runBuiltWorkers();

  expect(observations).toMatchObject([
    { label: "first", greeting: "hello" },
    { label: "second", greeting: "hello" },
  ]);
});

test("resolves SelectionProbe behavior in each Bun Worker", async () => {
  const observations = await runBuiltWorkers();

  expect(observations).toMatchObject([
    { label: "first", selection: ["preferred", "unique"] },
    { label: "second", selection: ["preferred", "unique"] },
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
