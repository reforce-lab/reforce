import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, cp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  copyApplicationProject,
  createTemporaryProject,
  resolveBunExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { sleep } from "radashi";

const e2eRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliRoot = join(workspaceRoot, "packages", "cli");
const cliEntry = join(cliRoot, "dist", "reforce.js");
const contextRoot = join(workspaceRoot, "packages", "context");
const configRoot = join(workspaceRoot, "packages", "config");
const toolingTsconfigRoot = join(workspaceRoot, "tooling", "tsconfig");
const bunTypesRoot = fileURLToPath(new URL(".", import.meta.resolve("@types/bun/package.json")));
const radashiRoot = fileURLToPath(new URL("..", import.meta.resolve("radashi")));
const applicationFixture = join(e2eRoot, "fixtures", "application");
const windowsSignalFixture = fileURLToPath(
  import.meta.resolve("@reforce/tooling-testing/windows-signal-harness"),
);
const commandTimeout = 120_000;
const bunExecutable = await resolveBunExecutable();

interface ApplicationFixture {
  readonly project: TemporaryProject;
  readonly isolatedArtifact: TemporaryProject;
  readonly buildExitCode: number;
}

interface StartedApplication {
  readonly child: ChildProcess;
  readonly completion: Promise<ProcessOutcome>;
  readonly inbox: IpcInbox;
  readonly output: () => { readonly stderr: string; readonly stdout: string };
  readonly marker: string;
  readonly readyPath: string;
  readonly closedPath: string;
}

interface StartedDevelopment extends SpawnedIpcProcess {
  readonly marker: string;
  readonly projectRoot: string;
  readonly readyPath: string;
  readonly closedPath: string;
}

interface ProcessOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface SpawnedIpcProcess {
  readonly child: ChildProcess;
  readonly completion: Promise<ProcessOutcome>;
  readonly inbox: IpcInbox;
  readonly output: () => { readonly stderr: string; readonly stdout: string };
}

class IpcInbox {
  private readonly child: ChildProcess;
  private readonly messages: unknown[] = [];
  private readonly waiters: Array<{
    readonly reject: (error: Error) => void;
    readonly resolve: (message: unknown) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  }> = [];
  private closedError?: Error;
  private readonly onMessage = (message: unknown) => {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.messages.push(message);
      return;
    }
    clearTimeout(waiter.timeout);
    waiter.resolve(message);
  };
  private readonly onError = (error: Error) => this.closeWith(error);
  private readonly onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    this.closeWith(
      new Error(
        `IPC subprocess exited before the expected message (code ${exitCode ?? "null"}, signal ${signal ?? "none"}).`,
      ),
    );
  };

  constructor(child: ChildProcess) {
    this.child = child;
    child.on("message", this.onMessage);
    child.on("error", this.onError);
    child.on("exit", this.onExit);
  }

  async next(message: string): Promise<unknown> {
    const queued = this.messages.shift();
    if (queued !== undefined) {
      return queued;
    }
    if (this.closedError !== undefined) {
      throw this.closedError;
    }
    return await new Promise<unknown>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          reject(new Error(message));
        }, 30_000),
      };
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.child.off("message", this.onMessage);
    this.child.off("error", this.onError);
    this.child.off("exit", this.onExit);
  }

  private closeWith(error: Error): void {
    this.closedError ??= error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(this.closedError);
    }
  }
}

async function withTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMilliseconds: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (await pathExists(path)) {
      return;
    }
    if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`Subprocess exited before creating ${path}.`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await sleep(20);
  }
}

async function waitForFileContent(
  path: string,
  expected: string,
  child?: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await readFile(path, "utf8")).includes(expected)) {
        return;
      }
    } catch {}
    if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`Subprocess exited before ${path} contained ${expected}.`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path} to contain ${expected}.`);
    }
    await sleep(20);
  }
}

function isShutdownAcknowledgement(
  value: unknown,
  requestId: string,
): value is { readonly ok: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "type") === "reforce:shutdown-ack" &&
    Reflect.get(value, "requestId") === requestId &&
    typeof Reflect.get(value, "ok") === "boolean"
  );
}

async function installApplicationPackages(
  projectRoot: string,
  contextDistribution: "dist-only" | "workspace" = "workspace",
): Promise<void> {
  const scopeRoot = join(projectRoot, "node_modules", "@reforce");
  const typesScopeRoot = join(projectRoot, "node_modules", "@types");
  const contextTarget = join(scopeRoot, "context");
  await Promise.all([
    mkdir(scopeRoot, { recursive: true }),
    mkdir(typesScopeRoot, { recursive: true }),
  ]);
  await Promise.all([
    symlink(
      toolingTsconfigRoot,
      join(scopeRoot, "tooling-tsconfig"),
      process.platform === "win32" ? "junction" : "dir",
    ),
    symlink(
      bunTypesRoot,
      join(typesScopeRoot, "bun"),
      process.platform === "win32" ? "junction" : "dir",
    ),
    cp(radashiRoot, join(projectRoot, "node_modules", "radashi"), { recursive: true }),
  ]);
  const configTarget = join(scopeRoot, "config");
  if (contextDistribution === "workspace") {
    await Promise.all([
      symlink(contextRoot, contextTarget, process.platform === "win32" ? "junction" : "dir"),
      symlink(configRoot, configTarget, process.platform === "win32" ? "junction" : "dir"),
    ]);
    return;
  }
  await Promise.all([mkdir(contextTarget), mkdir(configTarget)]);
  await Promise.all([
    cp(join(contextRoot, "package.json"), join(contextTarget, "package.json")),
    cp(join(contextRoot, "dist"), join(contextTarget, "dist"), { recursive: true }),
    cp(join(configRoot, "package.json"), join(configTarget, "package.json")),
    cp(join(configRoot, "dist"), join(configTarget, "dist"), { recursive: true }),
    // dotenv 是 @reforce/config 唯一的运行时依赖；dist-only 拷贝没有包内 node_modules，
    // 把真实包（穿透 bun 的符号链接）落到应用 node_modules。
    cp(
      realpathSync(join(configRoot, "node_modules", "dotenv")),
      join(projectRoot, "node_modules", "dotenv"),
      { recursive: true },
    ),
  ]);
}

const leafProbeSource = `import { Injectable } from "@reforce/context";

@Injectable()
export class LeafProbe {}
`;

function applicationCompilerOptions() {
  return {
    target: "ESNext",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    experimentalDecorators: false,
    emitDecoratorMetadata: false,
  };
}

function leafTsconfig(extendsPath: string): string {
  return `${JSON.stringify({
    extends: extendsPath,
    compilerOptions: { paths: { "@/*": ["./src/*"] } },
    include: ["src", ".reforce/generated/**/*.d.ts"],
  })}\n`;
}

async function createApplicationProject(
  contextDistribution: "dist-only" | "workspace" = "workspace",
): Promise<TemporaryProject> {
  const project = await createTemporaryProject();
  try {
    await copyApplicationProject(applicationFixture, project.projectRoot);
    await installApplicationPackages(project.projectRoot, contextDistribution);
    return project;
  } catch (error) {
    await project.cleanup();
    throw error;
  }
}

async function createMonorepoProject(): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    apps: {
      "admin service": {},
      "api service": {},
    },
    "package.json": `${JSON.stringify({ private: true, type: "module" })}\n`,
    "tsconfig.json": `${JSON.stringify({
      files: [],
      references: [{ path: "apps/api service" }, { path: "apps/admin service" }],
    })}\n`,
    "tsconfig.shared.json": `${JSON.stringify({
      compilerOptions: applicationCompilerOptions(),
    })}\n`,
  });
  try {
    await Promise.all(
      [
        { directory: "admin service", probeFile: "admin-leaf-probe.ts" },
        { directory: "api service", probeFile: "api-leaf-probe.ts" },
      ].map(async ({ directory, probeFile }) => {
        const applicationRoot = join(project.projectRoot, "apps", directory);
        await copyApplicationProject(applicationFixture, applicationRoot);
        const sourceRoot = join(applicationRoot, "src");
        await Promise.all([
          writeFile(
            join(applicationRoot, "tsconfig.json"),
            leafTsconfig("../../tsconfig.shared.json"),
          ),
          writeFile(join(sourceRoot, probeFile), leafProbeSource),
          rm(join(sourceRoot, "application.ts")),
          rm(join(sourceRoot, "greeting.ts")),
          rm(join(sourceRoot, "providers.ts")),
          rm(join(sourceRoot, "worker-lifecycle.ts")),
        ]);
      }),
    );
    await installApplicationPackages(project.projectRoot);
    return project;
  } catch (error) {
    await project.cleanup();
    throw error;
  }
}

async function buildProject(projectRoot: string, arguments_: readonly string[] = []) {
  return await runCommand(
    bunExecutable,
    [cliEntry, "build", "--project", projectRoot, ...arguments_],
    {
      cwd: projectRoot,
      timeout: commandTimeout,
    },
  );
}

function commandFailure(result: { readonly stdout: unknown; readonly stderr: unknown }): string {
  return `${String(result.stdout)}\n${String(result.stderr)}`;
}

function spawnIpcProcess(input: {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}): SpawnedIpcProcess {
  const child = spawn(input.executable, [...input.arguments], {
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const inbox = new IpcInbox(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: unknown) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk: unknown) => {
    stderr += String(chunk);
  });
  const completion = new Promise<ProcessOutcome>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  return {
    child,
    completion,
    inbox,
    output: () => ({ stdout, stderr }),
  };
}

async function sendIpc(
  child: ChildProcess,
  message: Readonly<Record<string, string>>,
): Promise<void> {
  if (!child.connected) {
    throw new Error("IPC subprocess is disconnected.");
  }
  await new Promise<void>((resolve, reject) => {
    child.send(message, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function processFailure(subprocess: SpawnedIpcProcess, outcome: ProcessOutcome): string {
  const output = subprocess.output();
  return `Subprocess exited with code ${outcome.exitCode ?? "null"} and signal ${outcome.signal ?? "none"}.\n${output.stdout}\n${output.stderr}`;
}

async function executeArtifact(input: {
  readonly executable: string;
  readonly projectRoot: string;
  readonly readyPath: string;
  readonly closedPath: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
}): Promise<void> {
  await rm(input.readyPath, { force: true });
  await rm(input.closedPath, { force: true });
  const subprocess = spawnIpcProcess({
    executable: input.executable,
    arguments: [join(input.projectRoot, "dist", "main.mjs")],
    cwd: input.projectRoot,
    env: {
      ...input.extraEnv,
      REFORCE_E2E_READY: input.readyPath,
      REFORCE_E2E_CLOSED: input.closedPath,
    },
  });
  let exited = false;
  try {
    await waitForFile(input.readyPath, subprocess.child);
    const requestId = randomUUID();
    await sendIpc(subprocess.child, { type: "reforce:shutdown", requestId });
    for (;;) {
      const message = await subprocess.inbox.next("Artifact shutdown acknowledgement timed out.");
      if (!isShutdownAcknowledgement(message, requestId)) {
        continue;
      }
      if (!message.ok) {
        throw new Error("Artifact reported a shutdown failure.");
      }
      break;
    }
    const result = await withTimeout(
      subprocess.completion,
      30_000,
      "Artifact did not exit after shutdown.",
    );
    exited = true;
    if (result.exitCode !== 0) {
      throw new Error(processFailure(subprocess, result));
    }
    await waitForFile(input.closedPath);
  } finally {
    if (!exited) {
      await forceCleanupProcess(subprocess);
    } else {
      subprocess.inbox.close();
    }
  }
}

function spawnStartCommand(input: {
  readonly projectRoot: string;
  readonly readyPath: string;
  readonly closedPath: string;
  readonly marker: string;
  readonly useWindowsSignalHarness?: boolean;
  readonly extraEnv?: Readonly<Record<string, string>>;
}): SpawnedIpcProcess {
  return spawnIpcProcess({
    executable: bunExecutable,
    arguments: input.useWindowsSignalHarness
      ? [windowsSignalFixture, cliEntry, "start", "--project", input.projectRoot]
      : [cliEntry, "start", "--project", input.projectRoot],
    cwd: input.projectRoot,
    env: {
      ...input.extraEnv,
      REFORCE_E2E_READY: input.readyPath,
      REFORCE_E2E_CLOSED: input.closedPath,
      REFORCE_E2E_MARKER: input.marker,
    },
  });
}

// leaf 选择的核心断言：只有被选中的 app 产出 dist 与 generated，monorepo 根和 sibling app 一片空白。
async function expectLeafOnlyBuild(
  monorepoRoot: string,
  builtApplication: string,
  untouchedApplication: string,
): Promise<void> {
  const appRoot = join(monorepoRoot, "apps", builtApplication);
  const untouchedRoot = join(monorepoRoot, "apps", untouchedApplication);
  expect(await pathExists(join(appRoot, "dist", "main.mjs"))).toBe(true);
  expect(await pathExists(join(appRoot, ".reforce", "generated", "beans.ts"))).toBe(true);
  expect(await pathExists(join(monorepoRoot, "dist"))).toBe(false);
  expect(await pathExists(join(monorepoRoot, ".reforce"))).toBe(false);
  expect(await pathExists(join(untouchedRoot, ".reforce"))).toBe(false);
  expect(await pathExists(join(untouchedRoot, "dist"))).toBe(false);
}

// ready/closed 标记文件各自只应有一行：多写一行就说明 Context 被关了不止一次。
async function expectGracefulClose(
  started: StartedApplication,
  result: ProcessOutcome,
): Promise<void> {
  expect(result.exitCode, processFailure(started, result)).toBe(0);
  expect(await readFile(started.readyPath, "utf8")).toBe(`${started.marker}:ready\n`);
  expect(await readFile(started.closedPath, "utf8")).toBe(`${started.marker}:closed\n`);
}

async function startApplication(
  projectRoot: string,
  marker = projectRoot,
  useWindowsSignalHarness = false,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<StartedApplication> {
  const suffix = randomUUID();
  const readyPath = join(projectRoot, `start-${suffix}.ready`);
  const closedPath = join(projectRoot, `start-${suffix}.closed`);
  const subprocess = spawnStartCommand({
    projectRoot,
    readyPath,
    closedPath,
    marker,
    useWindowsSignalHarness,
    extraEnv,
  });
  try {
    await waitForFile(readyPath, subprocess.child);
    return { ...subprocess, marker, readyPath, closedPath };
  } catch (error) {
    await forceCleanupProcess(subprocess);
    const output = subprocess.output();
    throw new Error(
      `Production start failed before readiness.\n${output.stdout}\n${output.stderr}`,
      { cause: error },
    );
  }
}

function spawnDevCommand(input: {
  readonly cwd: string;
  readonly projectDirectory: string;
  readonly readyPath: string;
  readonly closedPath: string;
  readonly marker: string;
  readonly tsconfigPath?: string;
}): SpawnedIpcProcess {
  const arguments_ = [
    cliEntry,
    "dev",
    "--project",
    input.projectDirectory,
    ...(input.tsconfigPath === undefined ? [] : ["--tsconfig", input.tsconfigPath]),
  ];
  return spawnIpcProcess({
    executable: bunExecutable,
    arguments: process.platform === "win32" ? [windowsSignalFixture, ...arguments_] : arguments_,
    cwd: input.cwd,
    env: {
      REFORCE_E2E_READY: input.readyPath,
      REFORCE_E2E_CLOSED: input.closedPath,
      REFORCE_E2E_MARKER: input.marker,
    },
  });
}

async function startDevelopment(input: {
  readonly cwd: string;
  readonly projectDirectory: string;
  readonly projectRoot: string;
  readonly marker: string;
  readonly tsconfigPath?: string;
}): Promise<StartedDevelopment> {
  const suffix = randomUUID();
  const readyPath = join(input.projectRoot, `dev-${suffix}.ready`);
  const closedPath = join(input.projectRoot, `dev-${suffix}.closed`);
  const subprocess = spawnDevCommand({ ...input, readyPath, closedPath });
  try {
    await waitForFile(readyPath, subprocess.child);
    return { ...subprocess, ...input, readyPath, closedPath };
  } catch (error) {
    await forceCleanupProcess(subprocess);
    throw error;
  }
}

async function shutdownWithIpc(started: StartedApplication) {
  const requestId = randomUUID();
  await sendIpc(started.child, { type: "reforce:shutdown", requestId });
  for (;;) {
    const message = await started.inbox.next("Start command shutdown acknowledgement timed out.");
    if (isShutdownAcknowledgement(message, requestId)) {
      const outcome = {
        acknowledgementOk: message.ok,
        result: await withTimeout(
          started.completion,
          30_000,
          "Start command did not exit after IPC shutdown.",
        ),
      };
      started.inbox.close();
      return outcome;
    }
  }
}

async function shutdownWithSignal(
  subprocess: SpawnedIpcProcess,
  signal: NodeJS.Signals,
): Promise<ProcessOutcome> {
  if (process.platform === "win32") {
    return await shutdownWithInjectedSignalEvent(subprocess, signal);
  }
  if (!subprocess.child.kill(signal)) {
    throw new Error(`Unable to deliver ${signal} to the CLI process.`);
  }
  const result = await withTimeout(
    subprocess.completion,
    30_000,
    `CLI process did not exit after ${signal}.`,
  ).catch((error: unknown) => {
    const output = subprocess.output();
    throw new Error(`${String(error)}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`, {
      cause: error,
    });
  });
  subprocess.inbox.close();
  return result;
}

async function shutdownWithInjectedSignalEvent(
  subprocess: SpawnedIpcProcess,
  signal: NodeJS.Signals,
): Promise<ProcessOutcome> {
  if (signal !== "SIGINT" && signal !== "SIGBREAK") {
    throw new Error(`The signal event harness does not support ${signal}.`);
  }
  await sendIpc(subprocess.child, { type: "reforce:e2e-signal", signal });
  const result = await withTimeout(
    subprocess.completion,
    30_000,
    `CLI process did not exit after the injected ${signal} event.`,
  );
  subprocess.inbox.close();
  return result;
}

async function forceCleanupProcess(subprocess: SpawnedIpcProcess): Promise<void> {
  subprocess.inbox.close();
  if (subprocess.child.exitCode === null && subprocess.child.signalCode === null) {
    if (process.platform === "win32") {
      subprocess.child.kill();
    } else {
      subprocess.child.kill("SIGKILL");
    }
  }
  await withTimeout(subprocess.completion, 5_000, "Forced subprocess cleanup timed out.").catch(
    () => undefined,
  );
}

async function forceCleanup(started: StartedApplication): Promise<void> {
  await forceCleanupProcess(started);
}

describe.serial("built Reforce CLI", () => {
  let application: ApplicationFixture | undefined;

  function currentApplication(): ApplicationFixture {
    if (application === undefined) {
      throw new Error("The application fixture has not been prepared.");
    }
    return application;
  }

  beforeAll(async () => {
    const project = await createApplicationProject();
    const build = await buildProject(project.projectRoot);
    if (build.exitCode !== 0) {
      await project.cleanup();
      throw new Error(`Standalone build failed.\n${commandFailure(build)}`);
    }
    const isolatedArtifact = await createTemporaryProject();
    try {
      await cp(join(project.projectRoot, "dist"), join(isolatedArtifact.projectRoot, "dist"), {
        recursive: true,
      });
    } catch (error) {
      await Promise.all([project.cleanup(), isolatedArtifact.cleanup()]);
      throw error;
    }
    application = { project, isolatedArtifact, buildExitCode: build.exitCode ?? 1 };
  }, commandTimeout);

  afterAll(async () => {
    if (application !== undefined) {
      await Promise.all([application.project.cleanup(), application.isolatedArtifact.cleanup()]);
    }
  });

  test("prints help from the built CLI entry", async () => {
    const result = await runCommand(bunExecutable, [cliEntry, "--help"], { timeout: 10_000 });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: reforce");
  });

  test("preserves the Bun shebang in the built CLI entry", async () => {
    const source = await readFile(cliEntry, "utf8");

    expect(source.split("\n", 1)).toEqual(["#!/usr/bin/env bun"]);
  });

  test("does not embed the build workspace path in the CLI entry", async () => {
    const source = await readFile(cliEntry, "utf8");

    expect(source).not.toContain(workspaceRoot);
    expect(source).not.toContain(pathToFileURL(workspaceRoot).href);
  });

  test("renders non-interactive failures without ANSI or prompts", async () => {
    const project = await createTemporaryProject();
    try {
      const result = await runCommand(
        bunExecutable,
        [cliEntry, "build", "--project", project.projectRoot],
        { timeout: 10_000 },
      );

      const output = `${result.stdout}${result.stderr}`;
      expect(result.exitCode).toBe(1);
      expect(output).toContain("PROJECT_CONFIG_NOT_FOUND");
      expect(output).not.toContain("\u001B[");
      expect(output).not.toContain("? ");
    } finally {
      await project.cleanup();
    }
  });

  test("publishes a standalone application with an exact generated tree and dynamic chunk", async () => {
    const fixture = currentApplication();
    const generatedFiles = await readdir(
      join(fixture.project.projectRoot, ".reforce", "generated"),
    );
    const chunkFiles = await readdir(join(fixture.project.projectRoot, "dist", "chunks"));

    expect(fixture.buildExitCode).toBe(0);
    expect(generatedFiles.sort()).toEqual([
      "beans.ts",
      "bootstrap.ts",
      "manifest.json",
      "qualifiers.d.ts",
    ]);
    expect(await pathExists(join(fixture.project.projectRoot, "dist", "main.mjs"))).toBe(true);
    expect(chunkFiles.some((file) => file.endsWith(".mjs"))).toBe(true);
  });

  test(
    "build consumes the Context distribution without its source tree",
    async () => {
      const project = await createApplicationProject("dist-only");
      try {
        const result = await buildProject(project.projectRoot);

        expect(result.exitCode, commandFailure(result)).toBe(0);
        expect(
          await pathExists(join(project.projectRoot, "node_modules", "@reforce", "context", "src")),
        ).toBe(false);
        expect(await pathExists(join(project.projectRoot, "dist", "main.mjs"))).toBe(true);
      } finally {
        await project.cleanup();
      }
    },
    commandTimeout,
  );

  test(
    "development consumes the Context distribution without its source tree",
    async () => {
      const project = await createApplicationProject("dist-only");
      let development: StartedDevelopment | undefined;
      try {
        development = await startDevelopment({
          cwd: project.projectRoot,
          projectDirectory: ".",
          projectRoot: project.projectRoot,
          marker: "dist-only-dev",
        });

        expect(await readFile(development.readyPath, "utf8")).toBe("dist-only-dev:ready\n");
        expect(
          await pathExists(join(project.projectRoot, "node_modules", "@reforce", "context", "src")),
        ).toBe(false);

        const result = await shutdownWithSignal(
          development,
          process.platform === "win32" ? "SIGBREAK" : "SIGINT",
        );

        expect(result.exitCode, processFailure(development, result)).toBe(0);
      } finally {
        if (development !== undefined) {
          await forceCleanupProcess(development);
        }
        await project.cleanup();
      }
    },
    commandTimeout,
  );

  test(
    "builds an application selected from a monorepo root with project",
    async () => {
      const monorepo = await createMonorepoProject();
      try {
        const result = await runCommand(
          bunExecutable,
          [cliEntry, "build", "--project", join("apps", "api service")],
          { cwd: monorepo.projectRoot, timeout: commandTimeout },
        );

        expect(result.exitCode, commandFailure(result)).toBe(0);
        await expectLeafOnlyBuild(monorepo.projectRoot, "api service", "admin service");
      } finally {
        await monorepo.cleanup();
      }
    },
    commandTimeout,
  );

  test(
    "builds a nested leaf config selected explicitly from a monorepo root",
    async () => {
      const monorepo = await createMonorepoProject();
      try {
        const result = await runCommand(
          bunExecutable,
          [
            cliEntry,
            "build",
            "--project",
            ".",
            "--tsconfig",
            join("apps", "admin service", "tsconfig.json"),
          ],
          { cwd: monorepo.projectRoot, timeout: commandTimeout },
        );

        expect(result.exitCode, commandFailure(result)).toBe(0);
        await expectLeafOnlyBuild(monorepo.projectRoot, "admin service", "api service");
      } finally {
        await monorepo.cleanup();
      }
    },
    commandTimeout,
  );

  test(
    "runs development with a nested leaf config selected explicitly from a monorepo root",
    async () => {
      const monorepo = await createMonorepoProject();
      const projectRoot = join(monorepo.projectRoot, "apps", "admin service");
      let development: StartedDevelopment | undefined;
      try {
        development = await startDevelopment({
          cwd: monorepo.projectRoot,
          projectDirectory: ".",
          projectRoot,
          marker: "leaf-tsconfig-dev",
          tsconfigPath: join("apps", "admin service", "tsconfig.json"),
        });

        expect(await readFile(development.readyPath, "utf8")).toBe("leaf-tsconfig-dev:ready\n");
        expect(await pathExists(join(projectRoot, ".reforce", "dev", "main.mjs"))).toBe(true);
        expect(await pathExists(join(monorepo.projectRoot, ".reforce"))).toBe(false);
        expect(
          await pathExists(join(monorepo.projectRoot, "apps", "api service", ".reforce")),
        ).toBe(false);

        await rm(development.readyPath);
        await writeFile(
          join(projectRoot, "src", "leaf-update.ts"),
          [
            'import { Injectable } from "@reforce/context";',
            "@Injectable()",
            "export class LeafUpdateProbe {}",
            "",
          ].join("\n"),
        );
        await waitForFileContent(
          join(projectRoot, ".reforce", "generated", "beans.ts"),
          "LeafUpdateProbe",
          development.child,
        );
        await waitForFile(development.closedPath, development.child);
        await waitForFile(development.readyPath, development.child);

        const result = await shutdownWithSignal(
          development,
          process.platform === "win32" ? "SIGBREAK" : "SIGTERM",
        );

        expect(result.exitCode, processFailure(development, result)).toBe(0);
        expect(await readFile(development.closedPath, "utf8")).toBe(
          "leaf-tsconfig-dev:closed\nleaf-tsconfig-dev:closed\n",
        );
      } finally {
        if (development !== undefined) {
          await forceCleanupProcess(development);
        }
        await monorepo.cleanup();
      }
    },
    commandTimeout,
  );

  test(
    "runs development from a standalone application working directory",
    async () => {
      const project = await createApplicationProject();
      let development: StartedDevelopment | undefined;
      try {
        development = await startDevelopment({
          cwd: project.projectRoot,
          projectDirectory: ".",
          projectRoot: project.projectRoot,
          marker: "standalone-dev",
        });

        expect(await readFile(development.readyPath, "utf8")).toBe("standalone-dev:ready\n");
        expect(await pathExists(join(project.projectRoot, ".reforce", "dev", "main.mjs"))).toBe(
          true,
        );
        expect(await pathExists(join(project.projectRoot, "dist"))).toBe(false);

        const result = await shutdownWithSignal(
          development,
          process.platform === "win32" ? "SIGBREAK" : "SIGINT",
        );

        expect(result.exitCode, processFailure(development, result)).toBe(0);
        expect(await readFile(development.closedPath, "utf8")).toBe("standalone-dev:closed\n");
      } finally {
        if (development !== undefined) {
          await forceCleanupProcess(development);
        }
        await project.cleanup();
      }
    },
    commandTimeout,
  );

  test(
    "runs development for only the selected monorepo application",
    async () => {
      const monorepo = await createMonorepoProject();
      const projectDirectory = join("apps", "api service");
      const projectRoot = join(monorepo.projectRoot, projectDirectory);
      let development: StartedDevelopment | undefined;
      try {
        development = await startDevelopment({
          cwd: monorepo.projectRoot,
          projectDirectory,
          projectRoot,
          marker: "monorepo-dev",
        });

        expect(await readFile(development.readyPath, "utf8")).toBe("monorepo-dev:ready\n");
        expect(await pathExists(join(projectRoot, ".reforce", "dev", "main.mjs"))).toBe(true);
        expect(await pathExists(join(monorepo.projectRoot, ".reforce"))).toBe(false);
        expect(
          await pathExists(join(monorepo.projectRoot, "apps", "admin service", ".reforce")),
        ).toBe(false);

        const result = await shutdownWithSignal(
          development,
          process.platform === "win32" ? "SIGBREAK" : "SIGINT",
        );

        expect(result.exitCode, processFailure(development, result)).toBe(0);
        expect(await readFile(development.closedPath, "utf8")).toBe("monorepo-dev:closed\n");
      } finally {
        if (development !== undefined) {
          await forceCleanupProcess(development);
        }
        await monorepo.cleanup();
      }
    },
    commandTimeout,
  );

  test(
    "runs two monorepo leaf applications in development without crossing state",
    async () => {
      const monorepo = await createMonorepoProject();
      const apiDirectory = join("apps", "api service");
      const adminDirectory = join("apps", "admin service");
      const apiRoot = join(monorepo.projectRoot, apiDirectory);
      const adminRoot = join(monorepo.projectRoot, adminDirectory);
      let apiDevelopment: StartedDevelopment | undefined;
      let adminDevelopment: StartedDevelopment | undefined;
      try {
        const [api, admin] = await Promise.all([
          startDevelopment({
            cwd: monorepo.projectRoot,
            projectDirectory: apiDirectory,
            projectRoot: apiRoot,
            marker: "api-dev",
          }),
          startDevelopment({
            cwd: monorepo.projectRoot,
            projectDirectory: adminDirectory,
            projectRoot: adminRoot,
            marker: "admin-dev",
          }),
        ]);
        apiDevelopment = api;
        adminDevelopment = admin;

        expect(await readFile(api.readyPath, "utf8")).toBe("api-dev:ready\n");
        expect(await readFile(admin.readyPath, "utf8")).toBe("admin-dev:ready\n");
        expect(await pathExists(join(apiRoot, ".reforce", "dev", "main.mjs"))).toBe(true);
        expect(await pathExists(join(adminRoot, ".reforce", "dev", "main.mjs"))).toBe(true);
        expect(await pathExists(join(monorepo.projectRoot, ".reforce"))).toBe(false);

        const [apiResult, adminResult] = await Promise.all([
          shutdownWithSignal(api, process.platform === "win32" ? "SIGBREAK" : "SIGINT"),
          shutdownWithSignal(admin, process.platform === "win32" ? "SIGBREAK" : "SIGINT"),
        ]);

        expect(apiResult.exitCode, processFailure(api, apiResult)).toBe(0);
        expect(adminResult.exitCode, processFailure(admin, adminResult)).toBe(0);
        expect(await readFile(api.closedPath, "utf8")).toBe("api-dev:closed\n");
        expect(await readFile(admin.closedPath, "utf8")).toBe("admin-dev:closed\n");
      } finally {
        await Promise.all([
          apiDevelopment === undefined ? Promise.resolve() : forceCleanupProcess(apiDevelopment),
          adminDevelopment === undefined
            ? Promise.resolve()
            : forceCleanupProcess(adminDevelopment),
        ]);
        await monorepo.cleanup();
      }
    },
    commandTimeout,
  );

  test(
    "builds two monorepo leaf applications concurrently without overwriting either output",
    async () => {
      const monorepo = await createMonorepoProject();
      const apiDirectory = join("apps", "api service");
      const adminDirectory = join("apps", "admin service");
      const apiRoot = join(monorepo.projectRoot, apiDirectory);
      const adminRoot = join(monorepo.projectRoot, adminDirectory);
      try {
        const [apiBuild, adminBuild] = await Promise.all([
          runCommand(bunExecutable, [cliEntry, "build", "--project", apiDirectory], {
            cwd: monorepo.projectRoot,
            timeout: commandTimeout,
          }),
          runCommand(bunExecutable, [cliEntry, "build", "--project", adminDirectory], {
            cwd: monorepo.projectRoot,
            timeout: commandTimeout,
          }),
        ]);

        const [apiBeans, adminBeans] = await Promise.all([
          readFile(join(apiRoot, ".reforce", "generated", "beans.ts"), "utf8"),
          readFile(join(adminRoot, ".reforce", "generated", "beans.ts"), "utf8"),
        ]);
        expect(apiBuild.exitCode, commandFailure(apiBuild)).toBe(0);
        expect(adminBuild.exitCode, commandFailure(adminBuild)).toBe(0);
        expect(apiBeans).toContain("api-leaf-probe");
        expect(apiBeans).not.toContain("admin-leaf-probe");
        expect(adminBeans).toContain("admin-leaf-probe");
        expect(adminBeans).not.toContain("api-leaf-probe");
        expect(await pathExists(join(apiRoot, "dist", "main.mjs"))).toBe(true);
        expect(await pathExists(join(adminRoot, "dist", "main.mjs"))).toBe(true);
        expect(await pathExists(join(monorepo.projectRoot, "dist"))).toBe(false);
      } finally {
        await monorepo.cleanup();
      }
    },
    commandTimeout,
  );

  test(
    "starts two monorepo leaf production artifacts concurrently without crossing lifecycle",
    async () => {
      const monorepo = await createMonorepoProject();
      const apiDirectory = join("apps", "api service");
      const adminDirectory = join("apps", "admin service");
      const apiRoot = join(monorepo.projectRoot, apiDirectory);
      const adminRoot = join(monorepo.projectRoot, adminDirectory);
      let apiStarted: StartedApplication | undefined;
      let adminStarted: StartedApplication | undefined;
      try {
        const [apiBuild, adminBuild] = await Promise.all([
          runCommand(bunExecutable, [cliEntry, "build", "--project", apiDirectory], {
            cwd: monorepo.projectRoot,
            timeout: commandTimeout,
          }),
          runCommand(bunExecutable, [cliEntry, "build", "--project", adminDirectory], {
            cwd: monorepo.projectRoot,
            timeout: commandTimeout,
          }),
        ]);
        if (apiBuild.exitCode !== 0 || adminBuild.exitCode !== 0) {
          throw new Error(
            `Concurrent monorepo builds failed.\n${commandFailure(apiBuild)}\n${commandFailure(adminBuild)}`,
          );
        }

        const [api, admin] = await Promise.all([
          startApplication(apiRoot, "api-start"),
          startApplication(adminRoot, "admin-start"),
        ]);
        apiStarted = api;
        adminStarted = admin;

        expect(await readFile(api.readyPath, "utf8")).toBe("api-start:ready\n");
        expect(await readFile(admin.readyPath, "utf8")).toBe("admin-start:ready\n");

        const [apiShutdown, adminShutdown] = await Promise.all([
          shutdownWithIpc(api),
          shutdownWithIpc(admin),
        ]);

        expect(apiShutdown.acknowledgementOk).toBe(true);
        expect(adminShutdown.acknowledgementOk).toBe(true);
        expect(apiShutdown.result.exitCode, processFailure(api, apiShutdown.result)).toBe(0);
        expect(adminShutdown.result.exitCode, processFailure(admin, adminShutdown.result)).toBe(0);
        expect(await readFile(api.closedPath, "utf8")).toBe("api-start:closed\n");
        expect(await readFile(admin.closedPath, "utf8")).toBe("admin-start:closed\n");
      } finally {
        await Promise.all([
          apiStarted === undefined ? Promise.resolve() : forceCleanup(apiStarted),
          adminStarted === undefined ? Promise.resolve() : forceCleanup(adminStarted),
        ]);
        await monorepo.cleanup();
      }
    },
    commandTimeout,
  );

  test(
    "runs the complete isolated production artifact with Bun",
    async () => {
      const fixture = currentApplication();
      const artifactRoot = fixture.isolatedArtifact.projectRoot;
      const readyPath = join(artifactRoot, "bun-artifact.ready");
      const closedPath = join(artifactRoot, "bun-artifact.closed");

      await executeArtifact({
        executable: process.execPath,
        projectRoot: artifactRoot,
        readyPath,
        closedPath,
      });

      expect(Reflect.get(process.versions, "bun")).toBe("1.3.14");
      expect(await pathExists(join(artifactRoot, "src"))).toBe(false);
      expect(await pathExists(join(artifactRoot, "node_modules"))).toBe(false);
      expect(await pathExists(readyPath)).toBe(true);
      expect(await pathExists(closedPath)).toBe(true);
    },
    commandTimeout,
  );

  // 配置注入主路径（ADR 0005，#130 / #146）：五层合成经 REFORCE_PROFILE 选层、进程 env 压顶，
  // 绑定实例注入 bean 后经 start 与 production artifact 两条链路取值。
  test(
    "binds layered .env configuration through start and the isolated artifact",
    async () => {
      const project = await createApplicationProject();
      let started: StartedApplication | undefined;
      let stopped = false;
      try {
        await writeFile(
          join(project.projectRoot, ".env"),
          "FIXTURE_SERVER_HOST=env-host\nFIXTURE_SERVER_PORT=3000\n",
        );
        await writeFile(join(project.projectRoot, ".env.prod"), "FIXTURE_SERVER_PORT=9000\n");
        const build = await buildProject(project.projectRoot);
        expect(build.exitCode, commandFailure(build)).toBe(0);

        const configOut = join(project.projectRoot, "config-probe.out");
        started = await startApplication(project.projectRoot, "config-start", false, {
          REFORCE_PROFILE: "prod",
          FIXTURE_SERVER_HOST: "process-host",
          REFORCE_E2E_CONFIG_OUT: configOut,
        });
        // 进程 env 压过 profile 文件的 host；port 来自 .env.prod 覆盖 .env。
        expect(await readFile(configOut, "utf8")).toBe("process-host:9000\n");
        const shutdown = await shutdownWithIpc(started);
        stopped = true;
        expect(shutdown.acknowledgementOk).toBe(true);
        expect(shutdown.result.exitCode).toBe(0);
      } finally {
        if (started !== undefined && !stopped) {
          await forceCleanup(started);
        }
        await project.cleanup();
      }

      // artifact 链路：.env 族落在制品根（cwd），直跑 dist/main.mjs。
      const fixture = currentApplication();
      const artifactRoot = fixture.isolatedArtifact.projectRoot;
      await writeFile(
        join(artifactRoot, ".env"),
        "FIXTURE_SERVER_HOST=artifact-host\nFIXTURE_SERVER_PORT=7000\n",
      );
      const artifactConfigOut = join(artifactRoot, "config-artifact.out");
      await executeArtifact({
        executable: process.execPath,
        projectRoot: artifactRoot,
        readyPath: join(artifactRoot, "config-artifact.ready"),
        closedPath: join(artifactRoot, "config-artifact.closed"),
        extraEnv: { REFORCE_E2E_CONFIG_OUT: artifactConfigOut },
      });
      expect(await readFile(artifactConfigOut, "utf8")).toBe("artifact-host:7000\n");
    },
    commandTimeout,
  );

  test(
    "runs and closes two built start commands without crossing application markers",
    async () => {
      const first = await createApplicationProject();
      const second = await createApplicationProject();
      let firstStarted: StartedApplication | undefined;
      let secondStarted: StartedApplication | undefined;
      try {
        const [firstBuild, secondBuild] = await Promise.all([
          buildProject(first.projectRoot),
          buildProject(second.projectRoot),
        ]);
        if (firstBuild.exitCode !== 0 || secondBuild.exitCode !== 0) {
          throw new Error(
            `Concurrent builds failed.\n${commandFailure(firstBuild)}\n${commandFailure(secondBuild)}`,
          );
        }

        [firstStarted, secondStarted] = await Promise.all([
          startApplication(first.projectRoot, "first-start"),
          startApplication(second.projectRoot, "second-start"),
        ]);

        expect(await readFile(firstStarted.readyPath, "utf8")).toBe("first-start:ready\n");
        expect(await readFile(secondStarted.readyPath, "utf8")).toBe("second-start:ready\n");

        const [firstShutdown, secondShutdown] = await Promise.all([
          shutdownWithIpc(firstStarted),
          shutdownWithIpc(secondStarted),
        ]);

        expect(firstShutdown.acknowledgementOk).toBe(true);
        expect(secondShutdown.acknowledgementOk).toBe(true);
        expect(
          firstShutdown.result.exitCode,
          processFailure(firstStarted, firstShutdown.result),
        ).toBe(0);
        expect(
          secondShutdown.result.exitCode,
          processFailure(secondStarted, secondShutdown.result),
        ).toBe(0);
        expect(await readFile(firstStarted.closedPath, "utf8")).toBe("first-start:closed\n");
        expect(await readFile(secondStarted.closedPath, "utf8")).toBe("second-start:closed\n");
      } finally {
        await Promise.all([
          firstStarted === undefined ? Promise.resolve() : forceCleanup(firstStarted),
          secondStarted === undefined ? Promise.resolve() : forceCleanup(secondStarted),
        ]);
        await Promise.all([first.cleanup(), second.cleanup()]);
      }
    },
    commandTimeout,
  );

  test(
    "holds the start reader lease until its production child exits",
    async () => {
      const fixture = currentApplication();
      const started = await startApplication(fixture.project.projectRoot);
      let stopped = false;
      try {
        const build = await buildProject(fixture.project.projectRoot);

        const shutdown = await shutdownWithIpc(started);
        stopped = true;
        expect(build.exitCode).toBe(1);
        expect(`${build.stdout}${build.stderr}`).toContain("PROJECT_BUSY");
        expect(shutdown.acknowledgementOk).toBe(true);
        expect(shutdown.result.exitCode).toBe(0);
      } finally {
        if (!stopped) {
          await forceCleanup(started);
        }
      }
    },
    commandTimeout,
  );

  test(
    "closes a production child through parent IPC",
    async () => {
      const fixture = currentApplication();
      const started = await startApplication(fixture.project.projectRoot);
      let stopped = false;
      try {
        const shutdown = await shutdownWithIpc(started);
        stopped = true;

        expect(shutdown.acknowledgementOk).toBe(true);
        expect(shutdown.result.exitCode).toBe(0);
        expect(await pathExists(started.closedPath)).toBe(true);
      } finally {
        if (!stopped) {
          await forceCleanup(started);
        }
      }
    },
    commandTimeout,
  );

  test(
    "closes a production child after an injected process signal event",
    async () => {
      const fixture = currentApplication();
      const marker = "injected-signal-event";
      const started = await startApplication(fixture.project.projectRoot, marker, true);
      let stopped = false;
      try {
        const result = await shutdownWithInjectedSignalEvent(started, "SIGINT");
        stopped = true;

        await expectGracefulClose(started, result);
      } finally {
        if (!stopped) {
          await forceCleanup(started);
        }
      }
    },
    commandTimeout,
  );

  const gracefulSignals: readonly NodeJS.Signals[] =
    process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  for (const signal of gracefulSignals) {
    test(
      `closes a production child exactly once after ${signal}`,
      async () => {
        const fixture = currentApplication();
        const marker = `signal-${signal}`;
        const started = await startApplication(
          fixture.project.projectRoot,
          marker,
          process.platform === "win32",
        );
        let stopped = false;
        try {
          const result = await shutdownWithSignal(started, signal);
          stopped = true;

          await expectGracefulClose(started, result);
        } finally {
          if (!stopped) {
            await forceCleanup(started);
          }
        }
      },
      commandTimeout,
    );
  }
});
