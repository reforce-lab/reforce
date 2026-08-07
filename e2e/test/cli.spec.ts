import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  copyApplicationProject,
  createTemporaryProject,
  resolveNodeExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { sleep } from "radashi";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { installApplicationPackages } from "../support/application-packages";

const e2eRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliRoot = join(workspaceRoot, "packages", "cli");
const cliEntry = join(cliRoot, "dist", "reforce.js");
// starter lib 编译只需要 @reforce/core 的 dist 类型面（fixture 应用副本的装配在
// support/application-packages.ts）。
const coreRoot = join(workspaceRoot, "packages", "core");
const applicationFixture = join(e2eRoot, "fixtures", "application");
const windowsSignalFixture = fileURLToPath(
  import.meta.resolve("@reforce/tooling-testing/windows-signal-harness"),
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

// 到点返回 false 而不是抛：调用方据此决定重试还是判死。子进程先退出仍是硬失败——继续轮询
// 只会把「进程崩了」拖成一个没有信息量的超时。
async function pollForFileContent(
  path: string,
  expected: string,
  timeoutMilliseconds: number,
  child?: ChildProcess,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    try {
      if ((await readFile(path, "utf8")).includes(expected)) {
        return true;
      }
    } catch {}
    if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`Subprocess exited before ${path} contained ${expected}.`);
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(20);
  }
}

async function waitForFileContent(
  path: string,
  expected: string,
  child?: ChildProcess,
): Promise<void> {
  if (await pollForFileContent(path, expected, 30_000, child)) {
    return;
  }
  throw new Error(`Timed out waiting for ${path} to contain ${expected}.`);
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

const leafProbeSource = `import { Injectable } from "@reforce/core";

@Injectable()
export class LeafProbe {}
`;

// 叶子删掉 fixture 的 application.ts（它 re-export 了被删的 greeting/providers），但日志绑定
// 现在随 logging starter 进图（RFC 0011 勘误，#242），所以要留一个最小的注册入口。
const leafApplicationSource = `import { defineApplication } from "@reforce/core";
import { logging } from "@reforce/logging";

export default defineApplication({ starters: [logging] });
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
          writeFile(join(sourceRoot, "application.ts"), leafApplicationSource),
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
    executable: nodeExecutable,
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
    executable: nodeExecutable,
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
    // 就绪超时最常见的原因是 dev 会话内的编译失败或子进程反复崩溃，
    // 不带会话输出的超时错误在 CI 上无法定位（#153 Windows 排障实录）。
    const output = subprocess.output();
    throw new Error(
      `Development session did not become ready: ${String(error)}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
      { cause: error },
    );
  }
}

// 哨兵重写的节奏钟（packages/cli/it/support/watch-harness.ts 同款取值理由）：只控制「多久
// 没等到就重写哨兵」，不判失败——判死仍归 vitest 的用例击杀钟 commandTimeout。
const watchDeliveryRetouchIntervalMilliseconds = 3_000;

// 事件流就绪屏障（Issue #224，#177 在 e2e 层的同款）：macOS 上 fs.watch 创建后 ≤10ms 窗口内
// 的写入事件可能永久丢失（nodejs/node#52601，#86 探针实证）。dev 报 ready 只证明首轮构建完成
// 与应用已启动，不证明事件流已就绪——真实用户从 dev 启动到首次保存隔着秒级，永远在窗口外，
// 测试却是 ready 后毫秒级内首次编辑，押的是平台竞态而不是本仓库的重建逻辑。
//
// #177 的屏障靠 in-process 的 invalidations / compilations 钩子取投递证据，这一层拿不到
// （CLI 是子进程），改用本层已有的可观测量：生成的 beans.ts 出现哨兵 bean 名。哨兵写入自己
// 可能正落在丢失窗口内——丢失是永久的，重写是唯一自愈手段，停滞一个节奏钟就带新序号重写。
//
// 返回前等完整个重启往返（closed → ready），因此调用方之后的编辑不会和屏障自己的重启抢
// marker 文件。closed marker 是追加写，调用方在自己的编辑前需要再清一次。
async function establishWatchDelivery(input: {
  readonly development: StartedDevelopment;
  readonly projectRoot: string;
}): Promise<void> {
  const sentinelPath = join(input.projectRoot, "src", "watch-delivery-probe.ts");
  const generatedBeansPath = join(input.projectRoot, ".reforce", "generated", "beans.ts");
  await rm(input.development.readyPath, { force: true });
  await rm(input.development.closedPath, { force: true });
  for (let attempt = 0; ; attempt += 1) {
    await writeFile(
      sentinelPath,
      [
        'import { Injectable } from "@reforce/core";',
        "",
        "@Injectable()",
        `export class WatchDeliveryProbe {} // watch-delivery-${attempt}`,
        "",
      ].join("\n"),
    );
    const delivered = await pollForFileContent(
      generatedBeansPath,
      "WatchDeliveryProbe",
      watchDeliveryRetouchIntervalMilliseconds,
      input.development.child,
    );
    if (delivered) {
      await waitForFile(input.development.closedPath, input.development.child);
      await waitForFile(input.development.readyPath, input.development.child);
      return;
    }
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

describe.sequential("built Reforce CLI", () => {
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
    const result = await runCommand(nodeExecutable, [cliEntry, "--help"], { timeout: 10_000 });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: reforce");
  });

  test("preserves the node shebang in the built CLI entry", async () => {
    const source = await readFile(cliEntry, "utf8");

    expect(source.split("\n", 1)).toEqual(["#!/usr/bin/env node"]);
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
      "routes.json",
      "routes.ts",
      "weaving.json",
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
          await pathExists(join(project.projectRoot, "node_modules", "@reforce", "core", "src")),
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
          await pathExists(join(project.projectRoot, "node_modules", "@reforce", "core", "src")),
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
          nodeExecutable,
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

        // 首次编辑必须发生在事件流已就绪之后，否则押注的是 macOS 的启动窗口而不是本仓库的
        // 重建逻辑（Issue #224）。屏障自己也走一次重启，closed marker 是追加写，因此下面
        // 两个 marker 都要清掉——末尾断言的两行 closed 是「本次编辑重启 + 最终关停」。
        await establishWatchDelivery({ development, projectRoot });

        await rm(development.readyPath, { force: true });
        await rm(development.closedPath, { force: true });
        await writeFile(
          join(projectRoot, "src", "leaf-update.ts"),
          [
            'import { Injectable } from "@reforce/core";',
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
    "runs the complete isolated production artifact with Node.js",
    async () => {
      const fixture = currentApplication();
      const artifactRoot = fixture.isolatedArtifact.projectRoot;
      const readyPath = join(artifactRoot, "node-artifact.ready");
      const closedPath = join(artifactRoot, "node-artifact.closed");

      await executeArtifact({
        executable: process.execPath,
        projectRoot: artifactRoot,
        readyPath,
        closedPath,
      });

      expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(24);
      expect(await pathExists(join(artifactRoot, "src"))).toBe(false);
      expect(await pathExists(join(artifactRoot, "node_modules"))).toBe(false);
      expect(await pathExists(readyPath)).toBe(true);
      expect(await pathExists(closedPath)).toBe(true);
    },
    commandTimeout,
  );

  // 集合注入主路径（ADR 0006 W6，#142 / #150）：readonly DefaultPort[] 收进全部实现，
  // @Order(1) 的 preferred 排在无 @Order 的 fallback 之前，顺序由编译期写进生成物。
  test(
    "injects the ordered provider collection through the isolated artifact",
    async () => {
      const fixture = currentApplication();
      const artifactRoot = fixture.isolatedArtifact.projectRoot;
      const collectionOut = join(artifactRoot, "collection-artifact.out");

      await executeArtifact({
        executable: process.execPath,
        projectRoot: artifactRoot,
        readyPath: join(artifactRoot, "collection-artifact.ready"),
        closedPath: join(artifactRoot, "collection-artifact.closed"),
        extraEnv: { REFORCE_E2E_COLLECTION_OUT: collectionOut },
      });

      expect(await readFile(collectionOut, "utf8")).toBe("preferred,fallback\n");
    },
    commandTimeout,
  );

  // 逐 logger 调级的完整链路（RFC 0011 L5 勘误，#242）。级别配置是应用里的显式
  // LoggingSettings bean（fixture 的 AppLogging 把 LoggingProbe 调开 debug），不再有
  // `.env` / `LOGGING_LEVEL_*` 通道——生产改级别 = 改代码重部署，是 owner 拍板的代价。
  //
  // 断言必须同时看两条 logger：只看被调开的那条，「全局降到 debug」也会绿。
  test(
    "lets LoggingSettings.levels open one logger without touching the others",
    async () => {
      const project = await createApplicationProject();
      let started: StartedApplication | undefined;
      let stopped = false;
      try {
        const build = await buildProject(project.projectRoot);
        expect(build.exitCode, commandFailure(build)).toBe(0);

        started = await startApplication(project.projectRoot, "logging-start", false);
        const shutdown = await shutdownWithIpc(started);
        stopped = true;
        expect(shutdown.result.exitCode).toBe(0);

        const { stderr } = started.output();
        const messages = stderr
          .split("\n")
          .flatMap((line) => {
            try {
              return [String(JSON.parse(line).message)];
            } catch {
              return [];
            }
          })
          .filter((message) => message.endsWith("probe debug") || message.endsWith("probe info"));
        // 调开的那条 logger 两级都在；没调的那条只剩 info——它的 debug 仍被门槛挡住。
        expect(new Set(messages)).toEqual(
          new Set(["logging probe debug", "logging probe info", "quiet probe info"]),
        );
      } finally {
        if (started !== undefined && !stopped) {
          await forceCleanup(started);
        }
        await project.cleanup();
      }
    },
    commandTimeout,
  );

  // A3（RFC 0011 D2，#250）：启动摘要此前只有渲染器没有生产者。非 TTY 下它走 Logger 发结构
  // 化记录；折叠必带计数与展开命令（不变量 4），所以 routes 段要同时有计数和 explain 出口。
  test(
    "emits a folded startup summary with counts and an expand command",
    async () => {
      const project = await createApplicationProject();
      let started: StartedApplication | undefined;
      let stopped = false;
      try {
        const build = await buildProject(project.projectRoot);
        expect(build.exitCode, commandFailure(build)).toBe(0);

        started = await startApplication(project.projectRoot, "summary-start");
        const shutdown = await shutdownWithIpc(started);
        stopped = true;
        expect(shutdown.result.exitCode).toBe(0);

        const records = started
          .output()
          .stderr.split("\n")
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          });
        const routes = records.find((record) => record.message === "routes");
        expect(routes).toMatchObject({ expandWith: "reforce explain routes" });
        expect(String(routes.facts.join(" · "))).toMatch(/\d+ controllers? · \d+ routes?/u);
        // 引擎段带实际监听地址：端口 0 时这是唯一的实际端口出口。
        expect(records.find((record) => record.message === "node")?.facts?.[0]).toMatch(
          /^listening on http:\/\//u,
        );
        // context 段带 bean 数与 start 耗时，末尾一条 ready 带总耗时。
        expect(records.find((record) => record.message === "context")).toBeDefined();
        expect(records.find((record) => record.message === "ready")).toMatchObject({
          startupMs: expect.any(Number),
        });
      } finally {
        if (started !== undefined && !stopped) {
          await forceCleanup(started);
        }
        await project.cleanup();
      }
    },
    commandTimeout,
  );

  // 不变量 4 的另一半（RFC 0011 D2，#242）：上一条用例只证明摘要**印出**了展开命令，没证明它
  // 跑得通。而它此前正是跑不通的——路由面的判据是「查询以 / 开头」，`routes` 这个词落到 bean
  // 面报「没有 bean 叫 routes」。折叠给了出口、出口是死的，比不给出口更糟。
  // 这条用例逐字敲摘要印出的那串命令，是这个缺陷唯一的稳定回归证据。
  test(
    "the expand command printed by the startup summary actually runs",
    async () => {
      const project = await createApplicationProject();
      try {
        const build = await buildProject(project.projectRoot);
        expect(build.exitCode, commandFailure(build)).toBe(0);

        const explain = await runCommand(
          nodeExecutable,
          [cliEntry, "explain", "routes", "--project", project.projectRoot],
          { cwd: project.projectRoot, timeout: commandTimeout },
        );

        expect(explain.exitCode, commandFailure(explain)).toBe(0);
        const stdout = String(explain.stdout);
        expect(stdout).toMatch(/^\d+ routes · \d+ controllers$/mu);
        expect(stdout).toContain('expand one route · reforce explain "<METHOD> <path>"');
      } finally {
        await project.cleanup();
      }
    },
    commandTimeout,
  );

  // C4（RFC 0011，#250）：配置来源。provenance 数据一直都有，只用于报错的 layer 字段，
  // 启动期一个字不打——「这个值到底是哪一层给的」得靠人去比对四个文件。
  //
  // 脱敏铁律（ADR 0005 决策 6.2）：只出键名与层，永不出值。这条用例用一个哨兵值证明否定。
  test(
    "reports which layer each config key came from without ever printing a value",
    async () => {
      const project = await createApplicationProject();
      let started: StartedApplication | undefined;
      let stopped = false;
      const secret = "s3cr3t-sentinel-value";
      try {
        const build = await buildProject(project.projectRoot);
        expect(build.exitCode, commandFailure(build)).toBe(0);

        // reforce.config 的 debug 档由 fixture 的 AppLogging.levels 调开（RFC 0011 L5 勘误：
        // 级别走显式 settings，env 通道已撤）。
        started = await startApplication(project.projectRoot, "provenance-start", false, {
          FIXTURE_SERVER_HOST: secret,
        });
        const shutdown = await shutdownWithIpc(started);
        stopped = true;
        expect(shutdown.result.exitCode).toBe(0);

        const stderr = started.output().stderr;
        const records = stderr
          .split("\n")
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          })
          .filter((record) => record.name === "reforce.config");
        expect(records.find((record) => record.message.startsWith("config keys"))).toMatchObject({
          keyCount: expect.any(Number),
          layers: expect.any(Array),
        });
        // debug 档展开出逐键来源，键名在、层在。
        const detail = records.find((record) => record.message === "config key provenance");
        expect(JSON.stringify(detail?.sources)).toContain("FIXTURE_SERVER_HOST");
        // 而值一次都没出现——整条 stderr 里都没有。
        expect(stderr).not.toContain(secret);
      } finally {
        if (started !== undefined && !stopped) {
          await forceCleanup(started);
        }
        await project.cleanup();
      }
    },
    commandTimeout,
  );

  // C3（RFC 0011，#250）：关停可观测。此前 ShutdownController 全程静默，只在失败时经
  // reporter 出声——「停了多久」「为什么停」这两个最常问的问题一个字都没有。
  test(
    "logs the drain start with its trigger and the stop with its duration",
    async () => {
      const project = await createApplicationProject();
      let started: StartedApplication | undefined;
      let stopped = false;
      try {
        const build = await buildProject(project.projectRoot);
        expect(build.exitCode, commandFailure(build)).toBe(0);

        started = await startApplication(project.projectRoot, "shutdown-start");
        const shutdown = await shutdownWithIpc(started);
        stopped = true;
        expect(shutdown.result.exitCode).toBe(0);

        const records = started
          .output()
          .stderr.split("\n")
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          });
        // 子进程看到的是信号：CLI 父进程收到 IPC 关停请求后是发信号给子进程的。信号名此前
        // 在 installProcessShutdownHandlers 里被整个丢掉，这条断言钉的就是它现在到得了字段。
        expect(records.find((record) => record.message === "shutting down")).toMatchObject({
          trigger: "SIGTERM",
        });
        expect(records.find((record) => record.message === "stopped")).toMatchObject({
          stopMs: expect.any(Number),
          exitCode: 0,
        });
      } finally {
        if (started !== undefined && !stopped) {
          await forceCleanup(started);
        }
        await project.cleanup();
      }
    },
    commandTimeout,
  );

  // C2（RFC 0011，#250）：崩溃接管。此前未捕获异常走 Node 默认路径，日志缓冲与 pino
  // worker thread 的尾部日志全丢。只能在真子进程上验：记录是否完整落地、退出码是否仍是 1。
  test(
    "takes over an uncaught exception with a fatal record and still exits nonzero",
    async () => {
      const project = await createApplicationProject();
      let started: StartedApplication | undefined;
      try {
        const build = await buildProject(project.projectRoot);
        expect(build.exitCode, commandFailure(build)).toBe(0);

        started = await startApplication(project.projectRoot, "crash-start", false, {
          REFORCE_E2E_CRASH: "1",
        });
        const outcome = await started.completion;

        expect(outcome.exitCode).toBe(1);
        const fatal = started
          .output()
          .stderr.split("\n")
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          })
          .find((record) => record.message === "uncaught exception");
        expect(fatal).toMatchObject({ level: "fatal", origin: "uncaughtException" });
        // 栈必须完整落进记录里：崩溃现场的全部价值就在这里。
        expect(String(fatal.err?.stack ?? "")).toContain("deliberate e2e crash");
      } finally {
        if (started !== undefined) {
          await forceCleanup(started);
        }
        await project.cleanup();
      }
    },
    commandTimeout,
  );

  // C6（RFC 0011，#250）：逐 bean 台账。断言的是 debug 明细而不是摘要里那条折叠的
  // slow beans——触发折叠要一条真的跑满 5ms 的 bean，而单例构造被强制同步返回，那意味着
  // 忙等，正是要避开的时序 flake。折叠规则由 @reforce/logging 的单测确定性覆盖。
  test(
    "streams one per-bean timing record when the context logger is opened to debug",
    async () => {
      const project = await createApplicationProject();
      let started: StartedApplication | undefined;
      let stopped = false;
      try {
        const build = await buildProject(project.projectRoot);
        expect(build.exitCode, commandFailure(build)).toBe(0);

        // 台账归 reforce.context：它是容器的事实不是 web 的（RFC 0011 L6【已定】）。debug 档
        // 由 fixture 的 AppLogging.levels 调开——级别走显式 settings，env 通道已撤。
        started = await startApplication(project.projectRoot, "timings-start", false);
        const shutdown = await shutdownWithIpc(started);
        stopped = true;
        expect(shutdown.result.exitCode).toBe(0);

        const timings = started
          .output()
          .stderr.split("\n")
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          })
          .filter((record) => record.message === "bean timing");
        expect(timings.length).toBeGreaterThan(0);
        expect(timings[0]).toMatchObject({
          bean: expect.any(String),
          phase: expect.any(String),
          ms: expect.any(Number),
        });
      } finally {
        if (started !== undefined && !stopped) {
          await forceCleanup(started);
        }
        await project.cleanup();
      }
    },
    commandTimeout,
  );

  // A2（RFC 0011 L7，#250）：引导期缓冲的重放此前是零调用的——@reforce/config 的绑定警告
  // 只能以进程退出时的裸 stderr 形态出现，进不了用户配置的日志格式与目标。
  //
  // 判据是 `bootstrapTime` 字段：它只由 replayInto 补上（缓冲保留原始时间戳，重放时刻是另
  // 一回事）。exit 兜底的 drainToStderr 不写这个字段，所以它在就证明走的是重放那条路。
  test(
    "replays a config binding warning through the real logger instead of the exit drain",
    async () => {
      const project = await createApplicationProject();
      let started: StartedApplication | undefined;
      let stopped = false;
      try {
        const build = await buildProject(project.projectRoot);
        expect(build.exitCode, commandFailure(build)).toBe(0);

        started = await startApplication(project.projectRoot, "replay-start", false, {
          // 拼错一个键：绑定期 warn「environment key matches no bound property」，带 did-you-mean。
          FIXTURE_SERVER_HOSTT: "typo",
        });
        const shutdown = await shutdownWithIpc(started);
        stopped = true;
        expect(shutdown.result.exitCode).toBe(0);

        const replayed = started
          .output()
          .stderr.split("\n")
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          })
          .filter((record) => record.name === "reforce.config");
        expect(replayed.length).toBeGreaterThan(0);
        // 按级别找而不是按下标：C4 之后同一条 logger 上先有一条来源摘要的 info。这条用例的
        // 判据本来就是 bootstrapTime（见上面的注释），不是记录在数组里的位置。
        expect(replayed.find((record) => record.level === "warn")).toMatchObject({
          level: "warn",
          bootstrapTime: expect.any(Number),
        });
      } finally {
        if (started !== undefined && !stopped) {
          await forceCleanup(started);
        }
        await project.cleanup();
      }
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
        // startApplication 只等 .ready，而 config-probe.out 由另一个 bean 的 onContextStart 写，
        // 两次写入间的调度间隙会被 20ms 轮询采样到（Issue #171）——先等内容落盘再断言精确值。
        // 进程 env 压过 profile 文件的 host；port 来自 .env.prod 覆盖 .env。
        await waitForFileContent(configOut, "process-host:9000\n", started.child);
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

// —— ADR 0004 M3（#148）：fixture starter 的完整消费链路与 dev watch 两条 install 路径 ——
//
// meta 由真实 `reforce lib`（构建后的 CLI）编出，不手写（M2 狗粮验收）；唯一的例外是
// defaultBean 位：M2 尚无作者侧授权面（消费侧 schema 自 M1 起支持），由本 harness 在编译产物上
// 注入并在 PR 交付说明中记账。fixture starter 复制到临时目录后再编译/安装，模板目录零污染。

const starterBaseFixture = join(e2eRoot, "fixtures", "starter-base");
const starterCacheFixture = join(e2eRoot, "fixtures", "starter-cache");

// lib 编译解析 starter src 的 `@reforce/core` import，只需要 dist 类型面。
async function installStarterCompilePackages(packageRoot: string): Promise<void> {
  const coreTarget = join(packageRoot, "node_modules", "@reforce", "core");
  await mkdir(coreTarget, { recursive: true });
  await Promise.all([
    cp(join(coreRoot, "package.json"), join(coreTarget, "package.json")),
    cp(join(coreRoot, "dist"), join(coreTarget, "dist"), { recursive: true }),
  ]);
}

interface CompiledStarters {
  readonly baseRoot: string;
  readonly cacheRoot: string;
}

async function compileStarterFixtures(workspaceRootPath: string): Promise<CompiledStarters> {
  const baseRoot = join(workspaceRootPath, "starter-base");
  const cacheRoot = join(workspaceRootPath, "starter-cache");
  await cp(starterBaseFixture, baseRoot, { recursive: true });
  await cp(starterCacheFixture, cacheRoot, { recursive: true });
  await installStarterCompilePackages(baseRoot);
  await installStarterCompilePackages(cacheRoot);
  const baseResult = await runCommand(nodeExecutable, [cliEntry, "lib", "--project", baseRoot], {
    cwd: baseRoot,
    timeout: commandTimeout,
  });
  expect(baseResult.exitCode, commandFailure(baseResult)).toBe(0);
  // base（含刚编出的 meta）装进 cache 的 node_modules：cache 编译时 Clock 才能归一为 meta 坐标
  // 并进 starterDeps。
  await cp(baseRoot, join(cacheRoot, "node_modules", "@acme", "starter-base"), {
    recursive: true,
  });
  const cacheResult = await runCommand(nodeExecutable, [cliEntry, "lib", "--project", cacheRoot], {
    cwd: cacheRoot,
    timeout: commandTimeout,
  });
  expect(cacheResult.exitCode, commandFailure(cacheResult)).toBe(0);
  // defaultBean 注入：M2 的 reforce lib 没有作者侧授权面（本 PR 交付说明记账），消费侧语义
  // （存在其他候选即让位）自 M1 起已实装，这里补上这一位以覆盖该场景。
  const metaPath = join(cacheRoot, "reforce-meta.json");
  // 断言依据：这份字节刚由上面的 reforce lib 写出并经其出口自检，形状由 lib 保证；JSON.parse
  // 的返回类型系统推不出来。
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as {
    beans: { id: string; defaultBean?: boolean }[];
  };
  for (const bean of meta.beans) {
    if (bean.id === "@acme/starter-cache#MemoryCache") {
      bean.defaultBean = true;
    }
  }
  await writeFile(metaPath, `${JSON.stringify(meta, undefined, 2)}\n`);
  return { baseRoot, cacheRoot };
}

async function installStarters(appRoot: string, starters: CompiledStarters): Promise<void> {
  const scopeRoot = join(appRoot, "node_modules", "@acme");
  await mkdir(scopeRoot, { recursive: true });
  await cp(starters.cacheRoot, join(scopeRoot, "starter-cache"), { recursive: true });
  await cp(starters.baseRoot, join(scopeRoot, "starter-base"), { recursive: true });
  // 剥掉编译期用的嵌套 node_modules：应用里只保留一份物理拷贝，starterDeps 解析提升到应用根。
  await rm(join(scopeRoot, "starter-cache", "node_modules"), { recursive: true, force: true });
  await rm(join(scopeRoot, "starter-base", "node_modules"), { recursive: true, force: true });
}

const starterRegistrationSource = `import { defineApplication } from "@reforce/core";
import { logging } from "@reforce/logging";
import { cache } from "@acme/starter-cache";

export default defineApplication({ starters: [logging, cache] });
`;

const cacheConfigSource = `import { Injectable } from "@reforce/core";
import type { CacheConfig } from "@acme/starter-cache";

@Injectable()
export class LocalCacheConfig implements CacheConfig {
  prefix(): string {
    return "e2e";
  }
}
`;

const cacheReaderSource = `import { Injectable } from "@reforce/core";
import type { Cache } from "@acme/starter-cache";

@Injectable()
export class CacheReader {
  constructor(readonly cache: Cache) {}

  read(): string {
    return this.cache.get("greeting");
  }
}
`;

const localCacheSource = `import { Injectable } from "@reforce/core";
import type { Cache } from "@acme/starter-cache";

@Injectable()
export class LocalCache implements Cache {
  get(key: string): string {
    return \`local:\${key}\`;
  }
}
`;

// 覆盖场景仍要消费 starter 的另一个 bean：一个在 manifest 里没有任何 bean 的 starter 对 explain
// 不可见（最小版声明过的盲点），让位关系要能展示，starter 必须至少留有一席之地。
const metricsReaderSource = `import { Injectable } from "@reforce/core";
import { CacheMetrics } from "@acme/starter-cache";

@Injectable()
export class MetricsReader {
  constructor(readonly metrics: CacheMetrics) {}

  hits(): number {
    return this.metrics.hits();
  }
}
`;

async function writeStarterApplicationSources(appRoot: string): Promise<void> {
  // defineApplication 每应用至多一次：fixture 模板自带 web-node 注册（#153），starter 场景
  // 用自己的注册整体替换 application.ts（本场景不消费 web 引擎与 worker barrel）。
  await writeFile(join(appRoot, "src", "application.ts"), starterRegistrationSource);
  await writeFile(join(appRoot, "src", "cache-config.ts"), cacheConfigSource);
  await writeFile(join(appRoot, "src", "cache-reader.ts"), cacheReaderSource);
}

async function createStarterApplication(
  workspaceRootPath: string,
  name: string,
  starters?: CompiledStarters,
): Promise<string> {
  const appRoot = join(workspaceRootPath, name);
  await mkdir(appRoot, { recursive: true });
  await copyApplicationProject(applicationFixture, appRoot);
  await installApplicationPackages(appRoot);
  await writeStarterApplicationSources(appRoot);
  if (starters !== undefined) {
    await installStarters(appRoot, starters);
  }
  return appRoot;
}

async function waitForStderr(subprocess: SpawnedIpcProcess, expected: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (subprocess.output().stderr.includes(expected)) {
      return;
    }
    if (subprocess.child.exitCode !== null || subprocess.child.signalCode !== null) {
      throw new Error(
        `Subprocess exited before printing ${expected}.\n${subprocess.output().stderr}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for output ${expected}.\n${subprocess.output().stderr}`);
    }
    await sleep(20);
  }
}

const devTerminationSignal: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGTERM";

describe.sequential("starter consumption", () => {
  let workspace: TemporaryProject;
  let starters: CompiledStarters;
  let appRoot: string;

  beforeAll(async () => {
    workspace = await createTemporaryProject();
    starters = await compileStarterFixtures(workspace.projectRoot);
    appRoot = await createStarterApplication(workspace.projectRoot, "app", starters);
    const result = await buildProject(appRoot);
    expect(result.exitCode, commandFailure(result)).toBe(0);
  });

  afterAll(async () => {
    await workspace.cleanup();
  });

  test(
    "links a reforce lib compiled starter with starterDeps and an app-supplied open edge",
    async () => {
      const manifest = await readFile(
        join(appRoot, ".reforce", "generated", "manifest.json"),
        "utf8",
      );
      expect(manifest).toContain('"origin": "@acme/starter-cache@1.0.0"');
      // starterDeps 自动拉入：应用只注册了 starter-cache，SystemClock 来自 base。
      expect(manifest).toContain('"origin": "@acme/starter-base@1.0.0"');
      const beans = await readFile(join(appRoot, ".reforce", "generated", "beans.ts"), "utf8");
      expect(beans).toContain('from "@acme/starter-cache"');
      expect(beans).toContain('from "@acme/starter-base"');
    },
    commandTimeout,
  );

  test(
    "starts the built application constructing starter beans",
    async () => {
      const started = await startApplication(appRoot, "starter-app");
      let stopped = false;
      try {
        const shutdown = await shutdownWithIpc(started);
        stopped = true;
        expect(shutdown.acknowledgementOk).toBe(true);
        await expectGracefulClose(started, shutdown.result);
      } finally {
        if (!stopped) {
          await forceCleanup(started);
        }
      }
    },
    commandTimeout,
  );

  test(
    "explains an accepted default starter bean from the generated manifest",
    async () => {
      const result = await runCommand(
        nodeExecutable,
        [cliEntry, "explain", "MemoryCache", "--project", appRoot],
        { cwd: appRoot, timeout: commandTimeout },
      );
      expect(result.exitCode, commandFailure(result)).toBe(0);
      const stdout = String(result.stdout);
      expect(stdout).toContain("bean @acme/starter-cache#MemoryCache");
      expect(stdout).toContain("origin @acme/starter-cache@1.0.0 · registered starter");
      expect(stdout).toContain("accepted default provider");
    },
    commandTimeout,
  );

  test(
    "a local provider overrides the starter default and explain reports the stand-aside",
    async () => {
      const overrideRoot = await createStarterApplication(
        workspace.projectRoot,
        "app-override",
        starters,
      );
      await writeFile(join(overrideRoot, "src", "local-cache.ts"), localCacheSource);
      await writeFile(join(overrideRoot, "src", "metrics-reader.ts"), metricsReaderSource);
      const result = await buildProject(overrideRoot);
      expect(result.exitCode, commandFailure(result)).toBe(0);

      const manifest = await readFile(
        join(overrideRoot, ".reforce", "generated", "manifest.json"),
        "utf8",
      );
      expect(manifest).not.toContain("MemoryCache");
      expect(manifest).toContain("CacheMetrics");

      const explain = await runCommand(
        nodeExecutable,
        [cliEntry, "explain", "LocalCache", "--project", overrideRoot],
        { cwd: overrideRoot, timeout: commandTimeout },
      );
      expect(explain.exitCode, commandFailure(explain)).toBe(0);
      const stdout = String(explain.stdout);
      expect(stdout).toContain("stood aside @acme/starter-cache#MemoryCache");
      expect(stdout).toContain("a local provider always wins");
    },
    commandTimeout,
  );

  // lockfile 不能只写一次：失败态的 watcher 刚建立，macOS 上 fs.watch 初期写入事件可能
  // 永久丢失（Issue #86 探针实证；产品侧决议是"再保存一次即自愈"，不加常驻补偿）。e2e 按
  // 同一语义周期性重写 lockfile 直到重发现完成，不赌单次事件必达（Issue #177 同理）。
  async function recoverThroughLockfileWrites(
    subprocess: SpawnedIpcProcess,
    readyPath: string,
    lockPath: string,
  ): Promise<void> {
    const deadline = Date.now() + 30_000;
    let lockWrittenAt = 0;
    for (;;) {
      if (Date.now() - lockWrittenAt >= 2_000) {
        lockWrittenAt = Date.now();
        await writeFile(lockPath, "lockfileVersion: '9.0'\n");
      }
      if (await pathExists(readyPath)) {
        return;
      }
      if (subprocess.child.exitCode !== null || subprocess.child.signalCode !== null) {
        throw new Error(`Subprocess exited before creating ${readyPath}.`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${readyPath}`);
      }
      await sleep(20);
    }
  }

  test(
    "development recovers when a missing starter is installed and pnpm-lock.yaml lands",
    async () => {
      const devRoot = await createStarterApplication(workspace.projectRoot, "app-sudden-install");
      const suffix = randomUUID();
      const readyPath = join(devRoot, `dev-${suffix}.ready`);
      const closedPath = join(devRoot, `dev-${suffix}.closed`);
      const subprocess = spawnDevCommand({
        cwd: devRoot,
        projectDirectory: devRoot,
        readyPath,
        closedPath,
        marker: "sudden-install",
      });
      try {
        // 注册的 starter 未安装：编译失败、保持 watch，不退出。
        await waitForStderr(subprocess, "STARTER_META_NOT_FOUND");
        // 模拟 pnpm install：先落包内容（node_modules 不被 watch），pnpm-lock.yaml 收尾触发重发现。
        await installStarters(devRoot, starters);
        await recoverThroughLockfileWrites(subprocess, readyPath, join(devRoot, "pnpm-lock.yaml"));
        const result = await shutdownWithSignal(subprocess, devTerminationSignal);
        expect(result.exitCode, processFailure(subprocess, result)).toBe(0);
      } finally {
        await forceCleanupProcess(subprocess);
      }
    },
    commandTimeout,
  );

  test(
    "development relinks after a starter upgrade lands through pnpm-lock.yaml",
    async () => {
      const devRoot = await createStarterApplication(
        workspace.projectRoot,
        "app-starter-upgrade",
        starters,
      );
      const development = await startDevelopment({
        cwd: devRoot,
        projectDirectory: devRoot,
        projectRoot: devRoot,
        marker: "starter-upgrade",
      });
      try {
        const installedCachePackage = join(
          devRoot,
          "node_modules",
          "@acme",
          "starter-cache",
          "package.json",
        );
        // 断言依据：fixture 的 package.json 由本仓库提交、上面刚复制而来；JSON.parse 推不出形状。
        const packageJson = JSON.parse(await readFile(installedCachePackage, "utf8")) as {
          version: string;
        };
        packageJson.version = "2.0.0";
        await writeFile(installedCachePackage, `${JSON.stringify(packageJson, undefined, 2)}\n`);
        await writeFile(join(devRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        // 升级经 pnpm-lock.yaml 信号进入重发现→重链接→重生成：manifest 的 origin 换代即证据。
        await waitForFileContent(
          join(devRoot, ".reforce", "generated", "manifest.json"),
          "@acme/starter-cache@2.0.0",
          development.child,
        );
        const result = await shutdownWithSignal(development, devTerminationSignal);
        expect(result.exitCode, processFailure(development, result)).toBe(0);
      } finally {
        await forceCleanupProcess(development);
      }
    },
    commandTimeout,
  );
});

// D1 的真终端一半（RFC 0011，#242；#247 §3.6 记为「未做」的那条）。
//
// 模式表有两个维度——流是不是 TTY、读者是工具还是应用——而在这条用例之前，**没有一个自动化
// 用例跑在真 TTY 上**：既有断言全在管道下，落的一律是 short。也就是说 human 这一整档、以及
// 「颜色按流判定」这条，只有人肉核对过。
//
// 真 pty 靠 util-linux 的 script(1) 分配。它把 stdout 与 stderr 并进同一个 pty，所以下面读的
// 是合并输出。非 Linux 跳过：script 的参数形态在 BSD/macOS 上不同，而这条用例要的只是
// 「存在一个真 TTY」，不值得为它写两套调用。
const ptyAvailable = process.platform === "linux";

async function runInPty(
  command: string,
  options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> },
) {
  return await runCommand("script", ["-qec", command, "/dev/null"], {
    cwd: options.cwd,
    timeout: commandTimeout,
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
  });
}

// 装配不出来的应用：MISSING_BEAN 带 sourceSpan，human 模式因此会画出源码框，
// 而 short 模式只有一行。两档的区别在这条诊断上最明显。
const missingBeanProbe = [
  'import { Injectable } from "@reforce/core";',
  "",
  "export interface AbsentGateway {",
  "  charge(): void;",
  "}",
  "",
  "@Injectable()",
  "export class PtyProbe {",
  "  constructor(private readonly gateway: AbsentGateway) {}",
  "}",
  "",
].join("\n");

describe.skipIf(!ptyAvailable).sequential("rendering mode on a real terminal", () => {
  async function brokenProject(): Promise<TemporaryProject> {
    const project = await createApplicationProject();
    await writeFile(join(project.projectRoot, "src", "pty-probe.ts"), missingBeanProbe);
    return project;
  }

  test(
    "a real tty renders diagnostics in human mode, a pipe renders them in short",
    async () => {
      const project = await brokenProject();
      try {
        const buildCommand = `${nodeExecutable} ${cliEntry} build --project ${project.projectRoot}`;
        const onTty = await runInPty(buildCommand, { cwd: project.projectRoot });
        const piped = await buildProject(project.projectRoot);

        expect(piped.exitCode).not.toBe(0);
        const ttyOutput = `${String(onTty.stdout)}${String(onTty.stderr)}`;
        const pipedOutput = `${String(piped.stdout)}${String(piped.stderr)}`;

        // human：主 span 的位置行（`-->`）与源码框在，一条诊断占好几行。
        expect(ttyOutput).toContain("MISSING_BEAN");
        expect(ttyOutput).toContain("-->");
        // short：一条诊断恰好一行，位置直接拼在码后面，没有源码框。
        expect(pipedOutput).toContain("MISSING_BEAN");
        expect(pipedOutput).not.toContain("-->");
      } finally {
        await project.cleanup();
      }
    },
    commandTimeout,
  );

  // 颜色不得是级别/严重度的唯一通道，且必须尊重 NO_COLOR（D2）。这两条在管道下永远是绿的
  // ——管道本来就不上色，只有真 TTY 才验得出「上色了」和「NO_COLOR 关掉了」。
  test(
    "a real tty colours the output and NO_COLOR takes it away without losing the words",
    async () => {
      const project = await brokenProject();
      try {
        const buildCommand = `${nodeExecutable} ${cliEntry} build --project ${project.projectRoot}`;
        const coloured = await runInPty(buildCommand, { cwd: project.projectRoot });
        const plain = await runInPty(buildCommand, {
          cwd: project.projectRoot,
          env: { NO_COLOR: "1" },
        });

        const ansiIntroducer = `${String.fromCodePoint(27)}[`;
        const colouredOutput = `${String(coloured.stdout)}${String(coloured.stderr)}`;
        const plainOutput = `${String(plain.stdout)}${String(plain.stderr)}`;

        expect(colouredOutput).toContain(ansiIntroducer);
        expect(plainOutput).not.toContain(ansiIntroducer);
        // 降级掉的只是颜色：码与严重度词一个字都不能少，否则色觉障碍与管道读者就丢信息了。
        expect(plainOutput).toContain("MISSING_BEAN");
        expect(plainOutput).toContain("error");
      } finally {
        await project.cleanup();
      }
    },
    commandTimeout,
  );

  // 应用日志的 human 档（RFC 0011 D2，#242）：dev TTY 下是对齐行（级别词右对齐 + 名字列
  // 定宽），不是 JSON。管道那一半由上面 "lets LoggingSettings.levels…" 用例覆盖——它解析的
  // 正是 JSON 行。
  test(
    "application logs render as aligned human lines on a real tty",
    async () => {
      const project = await createApplicationProject();
      try {
        const build = await buildProject(project.projectRoot);
        expect(build.exitCode, commandFailure(build)).toBe(0);

        // timeout 到点发 TERM，应用优雅关停后 script 才返回；输出在此之前早已写完。
        const startCommand = `timeout -s TERM 10 ${nodeExecutable} ${cliEntry} start --project ${project.projectRoot}`;
        const plain = await runInPty(startCommand, {
          cwd: project.projectRoot,
          env: { NO_COLOR: "1" },
        });

        const output = `${String(plain.stdout)}${String(plain.stderr)}`;
        // 级别词右对齐、名字列定宽（18 列）：消息的起点不随名字长短漂移。
        expect(output).toMatch(/ {2}info LoggingProbe {7}logging probe info/u);
        // 调开 debug 的那条同样以 human 形态出现——settings 在 human 档下照常生效。
        expect(output).toMatch(/ {1}debug LoggingProbe {7}logging probe debug/u);
        // human 档下不再是 JSON 行。
        expect(output).not.toContain('"message":"logging probe info"');
      } finally {
        await project.cleanup();
      }
    },
    commandTimeout,
  );

  test(
    "application log colour follows the tty and NO_COLOR strips it without losing the level word",
    async () => {
      const project = await createApplicationProject();
      try {
        const build = await buildProject(project.projectRoot);
        expect(build.exitCode, commandFailure(build)).toBe(0);

        const startCommand = `timeout -s TERM 10 ${nodeExecutable} ${cliEntry} start --project ${project.projectRoot}`;
        const coloured = await runInPty(startCommand, { cwd: project.projectRoot });
        const plain = await runInPty(startCommand, {
          cwd: project.projectRoot,
          env: { NO_COLOR: "1" },
        });

        const ansiIntroducer = `${String.fromCodePoint(27)}[`;
        const colouredOutput = `${String(coloured.stdout)}${String(coloured.stderr)}`;
        const plainOutput = `${String(plain.stdout)}${String(plain.stderr)}`;
        expect(colouredOutput).toContain("logging probe info");
        expect(colouredOutput).toContain(ansiIntroducer);
        expect(plainOutput).not.toContain(ansiIntroducer);
        // 降级掉的只是颜色：级别词与消息一个字都不能少（颜色不是级别的唯一通道，D2）。
        expect(plainOutput).toContain("info LoggingProbe");
        expect(plainOutput).toContain("logging probe info");
      } finally {
        await project.cleanup();
      }
    },
    commandTimeout,
  );

  // banner 同属 human 档：管道下不该出现（它对 grep 和采集系统都是噪音）。
  test(
    "the banner appears on a tty and nowhere else",
    async () => {
      const project = await brokenProject();
      try {
        const buildCommand = `${nodeExecutable} ${cliEntry} build --project ${project.projectRoot}`;
        const onTty = await runInPty(buildCommand, { cwd: project.projectRoot });
        const piped = await buildProject(project.projectRoot);

        expect(`${String(onTty.stdout)}${String(onTty.stderr)}`).toMatch(
          /reforce.*node \d+\.\d+\.\d+ {3}build/u,
        );
        expect(`${String(piped.stdout)}${String(piped.stderr)}`).not.toContain("node ");
      } finally {
        await project.cleanup();
      }
    },
    commandTimeout,
  );
});
