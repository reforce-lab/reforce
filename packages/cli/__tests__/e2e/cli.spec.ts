import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, cp, mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createTemporaryProject,
  resolveNodeExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { sleep } from "radashi";

const cliRoot = fileURLToPath(new URL("../..", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const cliEntry = join(cliRoot, "dist", "reforce.js");
const contextRoot = join(workspaceRoot, "packages", "context");
const windowsSignalFixture = fileURLToPath(
  new URL("../../fixtures/process/windows-signal.fixture.ts", import.meta.url),
);
const commandTimeout = 120_000;
const nodeExecutable = await resolveNodeExecutable();

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
  readonly #child: ChildProcess;
  readonly #messages: unknown[] = [];
  readonly #waiters: Array<{
    readonly reject: (error: Error) => void;
    readonly resolve: (message: unknown) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  }> = [];
  #closedError?: Error;
  readonly #onMessage = (message: unknown) => {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#messages.push(message);
      return;
    }
    clearTimeout(waiter.timeout);
    waiter.resolve(message);
  };
  readonly #onError = (error: Error) => this.#closeWith(error);
  readonly #onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    this.#closeWith(
      new Error(
        `IPC subprocess exited before the expected message (code ${exitCode ?? "null"}, signal ${signal ?? "none"}).`,
      ),
    );
  };

  constructor(child: ChildProcess) {
    this.#child = child;
    child.on("message", this.#onMessage);
    child.on("error", this.#onError);
    child.on("exit", this.#onExit);
  }

  async next(message: string): Promise<unknown> {
    const queued = this.#messages.shift();
    if (queued !== undefined) {
      return queued;
    }
    if (this.#closedError !== undefined) {
      throw this.#closedError;
    }
    return await new Promise<unknown>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) {
            this.#waiters.splice(index, 1);
          }
          reject(new Error(message));
        }, 30_000),
      };
      this.#waiters.push(waiter);
    });
  }

  close(): void {
    this.#child.off("message", this.#onMessage);
    this.#child.off("error", this.#onError);
    this.#child.off("exit", this.#onExit);
  }

  #closeWith(error: Error): void {
    this.#closedError ??= error;
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(this.#closedError);
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

async function linkContextPackage(projectRoot: string): Promise<void> {
  const scopeRoot = join(projectRoot, "node_modules", "@reforce");
  await mkdir(scopeRoot, { recursive: true });
  await symlink(
    contextRoot,
    join(scopeRoot, "context"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

function applicationSource(classPrefix = ""): string {
  const dependencyClass = `${classPrefix}DependencyProbe`;
  const lifecycleClass = `${classPrefix}LifecycleProbe`;
  return `import { appendFileSync, writeFileSync } from "node:fs";
import { Injectable, type OnContextClose, type OnContextStart } from "@reforce/context";

@Injectable()
export class ${dependencyClass} {}

@Injectable()
export class ${lifecycleClass} implements OnContextStart, OnContextClose {
  constructor(readonly dependency: ${dependencyClass}) {}

  onContextStart(): void {
    const path = process.env.REFORCE_E2E_READY;
    const marker = process.env.REFORCE_E2E_MARKER ?? "application";
    if (path) writeFileSync(path, \`\${marker}:ready\\n\`, "utf8");
  }

  onContextClose(): void {
    const path = process.env.REFORCE_E2E_CLOSED;
    const marker = process.env.REFORCE_E2E_MARKER ?? "application";
    if (path) appendFileSync(path, \`\${marker}:closed\\n\`, "utf8");
  }
}
`;
}

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

function leafTsconfig(extendsPath?: string): string {
  return `${JSON.stringify({
    ...(extendsPath === undefined ? {} : { extends: extendsPath }),
    ...(extendsPath === undefined ? { compilerOptions: applicationCompilerOptions() } : {}),
    include: ["src", ".reforce/generated/**/*.d.ts"],
  })}\n`;
}

async function createApplicationProject(): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    src: { "application.ts": applicationSource() },
    "package.json": `${JSON.stringify({ private: true, type: "module" })}\n`,
    "tsconfig.json": leafTsconfig(),
  });
  try {
    await linkContextPackage(project.projectRoot);
    return project;
  } catch (error) {
    await project.cleanup();
    throw error;
  }
}

async function createMonorepoProject(): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    apps: {
      "admin service": {
        src: { "application.ts": applicationSource("Admin") },
        "tsconfig.json": leafTsconfig("../../tsconfig.shared.json"),
      },
      "api service": {
        src: { "application.ts": applicationSource("Api") },
        "tsconfig.json": leafTsconfig("../../tsconfig.shared.json"),
      },
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
    await linkContextPackage(project.projectRoot);
    return project;
  } catch (error) {
    await project.cleanup();
    throw error;
  }
}

async function buildProject(projectRoot: string, arguments_: readonly string[] = []) {
  return await runCommand(
    nodeExecutable,
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
}): Promise<void> {
  await rm(input.readyPath, { force: true });
  await rm(input.closedPath, { force: true });
  const subprocess = spawnIpcProcess({
    executable: input.executable,
    arguments: [join(input.projectRoot, "dist", "main.mjs")],
    cwd: input.projectRoot,
    env: {
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
}): SpawnedIpcProcess {
  return spawnIpcProcess({
    executable: nodeExecutable,
    arguments: input.useWindowsSignalHarness
      ? [windowsSignalFixture, cliEntry, "start", "--project", input.projectRoot]
      : [cliEntry, "start", "--project", input.projectRoot],
    cwd: input.projectRoot,
    env: {
      REFORCE_E2E_READY: input.readyPath,
      REFORCE_E2E_CLOSED: input.closedPath,
      REFORCE_E2E_MARKER: input.marker,
    },
  });
}

async function startApplication(
  projectRoot: string,
  marker = projectRoot,
  useWindowsSignalHarness = false,
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
  });
  try {
    await waitForFile(readyPath, subprocess.child);
    return { ...subprocess, marker, readyPath, closedPath };
  } catch (error) {
    await forceCleanupProcess(subprocess);
    throw error;
  }
}

function spawnDevCommand(input: {
  readonly cwd: string;
  readonly projectDirectory: string;
  readonly readyPath: string;
  readonly closedPath: string;
  readonly marker: string;
}): SpawnedIpcProcess {
  return spawnIpcProcess({
    executable: nodeExecutable,
    arguments:
      process.platform === "win32"
        ? [windowsSignalFixture, cliEntry, "dev", "--project", input.projectDirectory]
        : [cliEntry, "dev", "--project", input.projectDirectory],
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
  );
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

  test("prints help from the built Node executable", async () => {
    const result = await runCommand(nodeExecutable, [cliEntry, "--help"], { timeout: 10_000 });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: reforce");
  });

  test("starts the built executable with a Node shebang", async () => {
    const source = await readFile(cliEntry, "utf8");

    expect(source.split("\n", 1)).toEqual(["#!/usr/bin/env node"]);
  });

  test("does not embed the build workspace path in the executable", async () => {
    const source = await readFile(cliEntry, "utf8");

    expect(source).not.toContain(workspaceRoot);
    expect(source).not.toContain(pathToFileURL(workspaceRoot).href);
  });

  test("renders non-interactive failures without ANSI or prompts", async () => {
    const project = await createTemporaryProject();
    try {
      const result = await runCommand(
        nodeExecutable,
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
    "builds an application selected from a monorepo root with project",
    async () => {
      const monorepo = await createMonorepoProject();
      try {
        const appRoot = join(monorepo.projectRoot, "apps", "api service");

        const result = await runCommand(
          nodeExecutable,
          [cliEntry, "build", "--project", join("apps", "api service")],
          { cwd: monorepo.projectRoot, timeout: commandTimeout },
        );

        expect(result.exitCode, commandFailure(result)).toBe(0);
        expect(await pathExists(join(appRoot, "dist", "main.mjs"))).toBe(true);
        expect(await pathExists(join(monorepo.projectRoot, "dist"))).toBe(false);
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
        const appRoot = join(monorepo.projectRoot, "apps", "admin service");

        const result = await runCommand(
          nodeExecutable,
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
        expect(await pathExists(join(appRoot, "dist", "main.mjs"))).toBe(true);
        expect(await pathExists(join(monorepo.projectRoot, "dist"))).toBe(false);
      } finally {
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
          runCommand(nodeExecutable, [cliEntry, "build", "--project", apiDirectory], {
            cwd: monorepo.projectRoot,
            timeout: commandTimeout,
          }),
          runCommand(nodeExecutable, [cliEntry, "build", "--project", adminDirectory], {
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
        expect(apiBeans).toContain("ApiLifecycleProbe");
        expect(apiBeans).not.toContain("AdminLifecycleProbe");
        expect(adminBeans).toContain("AdminLifecycleProbe");
        expect(adminBeans).not.toContain("ApiLifecycleProbe");
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
          runCommand(nodeExecutable, [cliEntry, "build", "--project", apiDirectory], {
            cwd: monorepo.projectRoot,
            timeout: commandTimeout,
          }),
          runCommand(nodeExecutable, [cliEntry, "build", "--project", adminDirectory], {
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
    "runs the complete production artifact with Node",
    async () => {
      const fixture = currentApplication();
      const artifactRoot = fixture.isolatedArtifact.projectRoot;
      const readyPath = join(artifactRoot, "node-artifact.ready");
      const closedPath = join(artifactRoot, "node-artifact.closed");
      const runtime = await runCommand(nodeExecutable, [
        "-p",
        'JSON.stringify({release:process.release.name,bun:Reflect.get(process.versions,"bun")})',
      ]);

      await executeArtifact({
        executable: nodeExecutable,
        projectRoot: artifactRoot,
        readyPath,
        closedPath,
      });

      expect(runtime.stdout).toBe('{"release":"node"}');
      expect(await pathExists(join(artifactRoot, "src"))).toBe(false);
      expect(await pathExists(join(artifactRoot, "node_modules"))).toBe(false);
      expect(await pathExists(readyPath)).toBe(true);
      expect(await pathExists(closedPath)).toBe(true);
    },
    commandTimeout,
  );

  test(
    "runs the same complete production artifact with Bun",
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
      expect(await pathExists(readyPath)).toBe(true);
      expect(await pathExists(closedPath)).toBe(true);
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

        expect(result.exitCode, processFailure(started, result)).toBe(0);
        expect(await readFile(started.readyPath, "utf8")).toBe(`${marker}:ready\n`);
        expect(await readFile(started.closedPath, "utf8")).toBe(`${marker}:closed\n`);
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

          expect(result.exitCode, processFailure(started, result)).toBe(0);
          expect(await readFile(started.readyPath, "utf8")).toBe(`${marker}:ready\n`);
          expect(await readFile(started.closedPath, "utf8")).toBe(`${marker}:closed\n`);
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
