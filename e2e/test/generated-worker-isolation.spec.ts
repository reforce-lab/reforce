import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundleEntry,
  copyApplicationProject,
  createTemporaryProject,
  resolveNodeExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterAll, beforeAll, expect, test } from "vitest";

const e2eRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const workerSupportRoot = join(e2eRoot, "support", "worker");
const applicationFixture = join(e2eRoot, "fixtures", "application");
const cliEntry = join(workspaceRoot, "packages", "cli", "dist", "reforce.js");
const coreRoot = join(workspaceRoot, "packages", "core");
const configRoot = join(workspaceRoot, "packages", "config");
const webRoot = join(workspaceRoot, "packages", "web");
const webNodeRoot = join(workspaceRoot, "packages", "web-node");
const loggingRoot = join(workspaceRoot, "packages", "logging");
const runtimeRoot = join(workspaceRoot, "packages", "runtime");
const toolingTsconfigRoot = join(workspaceRoot, "tooling", "tsconfig");
const nodeTypesRoot = fileURLToPath(new URL(".", import.meta.resolve("@types/node/package.json")));
const radashiRoot = fileURLToPath(new URL("..", import.meta.resolve("radashi")));
const commandTimeout = 120_000;
let temporaryProject: TemporaryProject | undefined;
let builtWorkerEntry: string | undefined;
let workerHarness: string | undefined;
let nodeExecutable: string | undefined;

function commandFailure(result: { readonly stderr?: unknown; readonly stdout?: unknown }): string {
  return `stdout:\n${String(result.stdout)}\nstderr:\n${String(result.stderr)}`;
}

async function runBuiltWorkers(): Promise<unknown> {
  if (
    temporaryProject === undefined ||
    builtWorkerEntry === undefined ||
    workerHarness === undefined ||
    nodeExecutable === undefined
  ) {
    throw new Error("Generated application Worker fixture has not been built.");
  }
  const result = await runCommand(nodeExecutable, [workerHarness, builtWorkerEntry], {
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
  const coreTarget = join(scopeRoot, "core");
  await Promise.all([
    mkdir(coreTarget, { recursive: true }),
    mkdir(typesScopeRoot, { recursive: true }),
  ]);
  await Promise.all([
    cp(join(coreRoot, "package.json"), join(coreTarget, "package.json")),
    cp(join(coreRoot, "dist"), join(coreTarget, "dist"), { recursive: true }),
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
    // fixture 应用现在是 web 应用（#153）：web 核心与 Node 引擎 starter 同样以符号链接落地，
    // 每个 Worker 里 bootstrap 会真的起 node:http 服务（端口 0），close 时排空停机。
    symlink(webRoot, join(scopeRoot, "web"), process.platform === "win32" ? "junction" : "dir"),
    symlink(
      webNodeRoot,
      join(scopeRoot, "web-node"),
      process.platform === "win32" ? "junction" : "dir",
    ),
    symlink(
      nodeTypesRoot,
      join(typesScopeRoot, "node"),
      process.platform === "win32" ? "junction" : "dir",
    ),
    // fixture 应用装了默认日志绑定（RFC 0011 L3）：@reforce/logging 与它的运行时依赖
    // @reforce/runtime 同样以符号链接落地，否则 logging-probe.ts 解析不到包。
    symlink(
      loggingRoot,
      join(scopeRoot, "logging"),
      process.platform === "win32" ? "junction" : "dir",
    ),
    symlink(
      runtimeRoot,
      join(scopeRoot, "runtime"),
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
  nodeExecutable = await resolveNodeExecutable();
  // 静态拼装打包入口：esbuild 才能把生成物与应用源码（含 TC39 装饰器，经 SWC 降级）
  // 收进同一个 bundle；每个 Worker 独立模块图的隔离语义保持不变。
  await writeFile(
    join(temporaryProject.projectRoot, "worker-bundle-entry.ts"),
    [
      'import * as applicationModule from "./project/src/application";',
      'import * as bootstrapModule from "./project/.reforce/generated/bootstrap";',
      'import { observeApplication } from "./worker-entry";',
      "",
      "await observeApplication(bootstrapModule, applicationModule);",
      "",
    ].join("\n"),
  );
  await bundleEntry({
    entry: "worker-bundle-entry.ts",
    cwd: temporaryProject.projectRoot,
    outfile: builtWorkerEntry,
  });
}, commandTimeout);

afterAll(async () => {
  await temporaryProject?.cleanup();
});

test("keeps generated singleton state isolated in each Node.js Worker", async () => {
  const observations = await runBuiltWorkers();

  expect(observations).toMatchObject([
    { label: "first", singleton: true, alphaMarker: 1 },
    { label: "second", singleton: true, alphaMarker: 1 },
  ]);
});

test("keeps generated cycle proxy state isolated in each Node.js Worker", async () => {
  const observations = await runBuiltWorkers();

  expect(observations).toMatchObject([
    { label: "first", cycleProxyDistinct: true, cycleProxyMarker: 1 },
    { label: "second", cycleProxyDistinct: true, cycleProxyMarker: 1 },
  ]);
});

test("keeps generated Lazy state isolated in each Node.js Worker", async () => {
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

test("resolves GreetingService behavior in each Node.js Worker", async () => {
  const observations = await runBuiltWorkers();

  expect(observations).toMatchObject([
    { label: "first", greeting: "hello" },
    { label: "second", greeting: "hello" },
  ]);
});

test("resolves SelectionProbe behavior in each Node.js Worker", async () => {
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
