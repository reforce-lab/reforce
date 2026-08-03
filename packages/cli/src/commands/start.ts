import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isPathStrictlyContained } from "@reforce/primitives";
import { isObject } from "radashi";
import { requireBunExecutable } from "@/bun-runtime";
import {
  isShutdownAcknowledgementMessage,
  isShutdownRequestMessage,
  type ShutdownAckMessage,
  type ShutdownRequestMessage,
} from "@/dev-ipc";
import { installTerminationSignalHandlers } from "@/process-signals";
import { findIncompleteDistTransaction } from "@/project/directory-transaction";
import { ProjectBusyError, ProjectLease, parseParticipant } from "@/project/lease";
import type { LeaseParticipant } from "@/project/lease-endpoint";
import {
  captureFailure,
  createFailureEvent,
  type Reporter,
  reportShutdownFailure,
} from "@/reporter";
import { withTimeout } from "@/with-timeout";

export interface StartCommandOptions {
  readonly cwd: string;
  readonly projectDirectory: string;
  readonly reporter: Reporter;
  readonly bunExecutable?: string;
}

export interface StartCommandDependencies {
  spawnChild(input: {
    readonly executable: string;
    readonly entryPath: string;
    readonly projectRoot: string;
    readonly leaseToken: string;
  }): ProductionChild;
  releaseLease(lease: ProjectLease): Promise<void>;
  removeParticipant(lease: ProjectLease, participantToken: string): Promise<void>;
  // 关停请求发出后还能等子进程多久。到点强杀，否则用户应用里一个 settle 不了的 close 钩子就让
  // reforce start 在终端里杀不掉（Issue #103）。
  readonly shutdownGraceMilliseconds: number;
}

const defaultDependencies: StartCommandDependencies = {
  spawnChild: spawnProductionChild,
  releaseLease: (lease) => lease.release(),
  removeParticipant: (lease, participantToken) => lease.removeParticipant(participantToken),
  shutdownGraceMilliseconds: 30_000,
};

class ArtifactInvalidError extends Error {
  readonly code = "ARTIFACT_INVALID" as const;

  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options);
    this.name = "ArtifactInvalidError";
  }
}

// 握手完成前收到终止信号时用它中止等待，而不是把信号排队到握手结束（Issue #103）。
class TerminationRequestedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminationRequestedError";
  }
}

// 严格变体：projectRoot 自身不可能是生产入口文件，等值一律拒绝。
function assertContained(root: string, target: string): void {
  if (isPathStrictlyContained(root, target)) {
    return;
  }
  throw new Error(`Production entry resolves outside projectRoot: ${target}`);
}

// 只负责信封：participant 本身的字段规则由 @/project/lease 的 parseParticipant 独占。
function parseChildParticipantMessage(value: unknown): LeaseParticipant | undefined {
  if (!isObject(value) || Reflect.get(value, "type") !== "reforce:lease-participant") {
    return undefined;
  }
  const participant = parseParticipant(Reflect.get(value, "participant"));
  // parent 角色的记录只可能是本进程自己写进 lease 的，不会从子进程 IPC 回来；收到就说明对端不是
  // 我们 spawn 的那个生产运行时。
  return participant?.role === "child" ? participant : undefined;
}

interface ProductionChildResult {
  readonly exitCode?: number;
}

interface ProductionChild {
  getOneMessage(): Promise<unknown>;
  sendMessage(message: ShutdownRequestMessage | LeaseParticipantAck): Promise<void>;
  // 「请关停」的唯一入口：用什么手段关停由子进程句柄决定，调用方不做平台判断。
  requestShutdown(signal: NodeJS.Signals): Promise<void>;
  kill(signal: NodeJS.Signals): void;
  wait(): Promise<ProductionChildResult>;
}

// 父进程转达的默认终止信号。Windows 上没有 SIGTERM，取 SIGBREAK（与 process-signals 所监听的一致）。
const parentTerminationSignal: NodeJS.Signals =
  process.platform === "win32" ? "SIGBREAK" : "SIGTERM";

// Sender half of the production-wire acknowledgement validated by `isLeaseParticipantAck` in
// production-runtime.ts. Unlike the dev wire's `DevChildLeaseParticipantAcknowledgement`
// (dev-ipc.ts), it carries no `ok`: this parent only acks after `lease.addParticipant` has
// succeeded, and a failure there fails the command instead of nacking the child.
interface LeaseParticipantAck {
  readonly type: "reforce:lease-participant-ack";
  readonly participantToken: string;
}

class BunProductionChild implements ProductionChild {
  private readonly completion: Promise<ProductionChildResult>;
  private readonly messages: unknown[] = [];
  private readonly messageWaiters: Array<{
    readonly reject: (error: Error) => void;
    readonly resolve: (message: unknown) => void;
  }> = [];
  private readonly process: ChildProcess;
  private terminalError: Error | undefined;

  constructor(process: ChildProcess) {
    this.process = process;
    process.on("message", (message: unknown) => {
      const waiter = this.messageWaiters.shift();
      if (waiter) {
        waiter.resolve(message);
        return;
      }
      this.messages.push(message);
    });
    this.completion = new Promise((resolve, reject) => {
      process.once("error", (error) => {
        this.closeInbox(error);
        reject(error);
      });
      process.once("exit", (exitCode, signal) => {
        this.closeInbox(
          new Error(
            `Production child exited before its IPC message (code ${exitCode ?? "null"}, signal ${signal ?? "none"}).`,
          ),
        );
        resolve(exitCode === null ? {} : { exitCode });
      });
    });
  }

  getOneMessage(): Promise<unknown> {
    const message = this.messages.shift();
    if (message !== undefined) {
      return Promise.resolve(message);
    }
    if (this.terminalError) {
      return Promise.reject(this.terminalError);
    }
    return new Promise((resolve, reject) => this.messageWaiters.push({ resolve, reject }));
  }

  async sendMessage(message: ShutdownRequestMessage | LeaseParticipantAck): Promise<void> {
    if (!this.process.connected) {
      throw new Error("The production child IPC channel is unavailable.");
    }
    await new Promise<void>((resolve, reject) => {
      this.process.send(message, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  // Windows has no POSIX signal semantics: `child.kill("SIGTERM")` there maps to TerminateProcess
  // and the child gets no chance to shut down gracefully. On win32 shutdown must instead go through
  // the IPC handshake (`reforce:shutdown` out, `reforce:shutdown-ack` back), so the child can run
  // its own shutdown path. The branch belongs here rather than in the command flow: callers only
  // ever want "shut this child down", and a platform check in the caller gets copied by the next one.
  async requestShutdown(signal: NodeJS.Signals): Promise<void> {
    if (process.platform !== "win32") {
      this.kill(signal);
      return;
    }
    const requestId = randomUUID();
    await this.sendMessage({ type: "reforce:shutdown", requestId });
    for (;;) {
      const message = await nextMessage(this, 30_000);
      if (isShutdownAcknowledgementMessage(message) && message.requestId === requestId) {
        if (!message.ok) {
          throw new Error("The production child reported a shutdown failure.");
        }
        return;
      }
    }
  }

  kill(signal: NodeJS.Signals): void {
    this.process.kill(signal);
  }

  wait(): Promise<ProductionChildResult> {
    return this.completion;
  }

  private closeInbox(error: Error): void {
    this.terminalError ??= error;
    for (const waiter of this.messageWaiters.splice(0)) {
      waiter.reject(this.terminalError);
    }
  }
}

function spawnProductionChild(input: {
  readonly executable: string;
  readonly entryPath: string;
  readonly projectRoot: string;
  readonly leaseToken: string;
}): ProductionChild {
  return new BunProductionChild(
    spawn(input.executable, [input.entryPath], {
      cwd: input.projectRoot,
      env: { ...process.env, REFORCE_LEASE_TOKEN: input.leaseToken },
      shell: false,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      windowsHide: true,
    }),
  );
}

function nextMessage(child: ProductionChild, timeoutMilliseconds: number): Promise<unknown> {
  return withTimeout(
    child.getOneMessage(),
    timeoutMilliseconds,
    "The production child IPC handshake timed out.",
  );
}

async function resolveProjectRoot(projectDirectory: string): Promise<string> {
  const projectRoot = await realpath(projectDirectory);
  const rootMetadata = await lstat(projectRoot);
  if (!rootMetadata.isDirectory()) {
    throw new Error(`Project root is not a directory: ${projectDirectory}`);
  }
  return projectRoot;
}

async function assertNoIncompleteDistTransaction(projectRoot: string): Promise<void> {
  const incomplete = await findIncompleteDistTransaction(projectRoot);
  if (incomplete === undefined) {
    return;
  }
  if (incomplete.reason === "journal") {
    throw new ArtifactInvalidError(
      "Production artifact has an incomplete dist transaction; run reforce build to recover it.",
    );
  }
  throw new ArtifactInvalidError(
    `Production artifact has incomplete transaction output: ${incomplete.entryName}`,
  );
}

async function assertOrdinaryArtifactTree(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ArtifactInvalidError(
        `Production artifact cannot contain a symbolic link: ${entryPath}`,
      );
    }
    if (entry.isDirectory()) {
      await assertOrdinaryArtifactTree(entryPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new ArtifactInvalidError(
        `Production artifact must contain only ordinary files: ${entryPath}`,
      );
    }
  }
}

async function resolveProductionEntry(projectRoot: string): Promise<string> {
  await assertNoIncompleteDistTransaction(projectRoot);
  const distRoot = join(projectRoot, "dist");
  try {
    const distMetadata = await lstat(distRoot);
    // lstat 不跟随链接，符号链接的 isDirectory() 恒为 false，所以 symlink 必须先判：放在后面
    // 只会让链接到目录的 dist 拿到「不是目录」这句与事实不符的文案（Issue #103）。
    if (distMetadata.isSymbolicLink()) {
      throw new ArtifactInvalidError(`Production artifact cannot be a symbolic link: ${distRoot}`);
    }
    if (!distMetadata.isDirectory()) {
      throw new ArtifactInvalidError(`Production artifact is not a directory: ${distRoot}`);
    }
    await assertOrdinaryArtifactTree(distRoot);
  } catch (cause) {
    if (cause instanceof ArtifactInvalidError) {
      throw cause;
    }
    throw new ArtifactInvalidError(`Production artifact is unavailable: ${distRoot}`, { cause });
  }
  const requestedEntry = join(projectRoot, "dist", "main.mjs");
  let entryPath: string;
  try {
    entryPath = await realpath(requestedEntry);
  } catch (cause) {
    throw new ArtifactInvalidError(`Production artifact is unavailable: ${requestedEntry}`, {
      cause,
    });
  }
  assertContained(projectRoot, entryPath);
  const entryMetadata = await lstat(entryPath);
  if (!entryMetadata.isFile()) {
    throw new ArtifactInvalidError(`Production entry is not an ordinary file: ${requestedEntry}`);
  }
  return entryPath;
}

function reportStartFailure(reporter: Reporter, error: unknown): void {
  if (error instanceof ProjectBusyError) {
    reporter.report(
      createFailureEvent({
        command: "start",
        phase: "project",
        fallbackCode: "PROJECT_BUSY",
        message: error.message,
        cause: error,
      }),
    );
    return;
  }
  if (error instanceof ArtifactInvalidError) {
    reporter.report(
      createFailureEvent({
        command: "start",
        phase: "build",
        fallbackCode: "ARTIFACT_INVALID",
        message: error.message,
        cause: error,
      }),
    );
    return;
  }
  reporter.report(
    createFailureEvent({
      command: "start",
      phase: "child",
      fallbackCode: "CHILD_FAILED",
      message: "Production application failed.",
      cause: error,
    }),
  );
}

interface StartCommandState {
  lease?: ProjectLease;
  child?: ProductionChild;
  participantToken?: string;
  readonly parentShutdownRequestIds: string[];
  detachSignals(): void;
}

async function startProductionChild(input: {
  readonly options: StartCommandOptions;
  readonly dependencies: StartCommandDependencies;
  readonly state: StartCommandState;
}): Promise<string> {
  const projectRoot = await resolveProjectRoot(
    resolve(input.options.cwd, input.options.projectDirectory),
  );
  const lease = await ProjectLease.acquire({ projectRoot, mode: "reader" });
  input.state.lease = lease;
  const entryPath = await resolveProductionEntry(projectRoot);
  const child = input.dependencies.spawnChild({
    executable: input.options.bunExecutable ?? requireBunExecutable(),
    entryPath,
    projectRoot,
    leaseToken: lease.leaseToken,
  });
  input.state.child = child;

  const graceMilliseconds = input.dependencies.shutdownGraceMilliseconds;
  let shutdownPromise: Promise<void> | undefined;
  let childHandshakeReady = false;
  let queuedSignal: NodeJS.Signals | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let forceKilled = false;
  // 转达关停之后子进程可能永远不退出（settle 不了的 close 钩子、排不干的连接池），而 child.wait()
  // 无界，所以必须自带宽限期（Issue #103）。unref 的理由与 with-timeout.ts 相同：活着的子进程句柄
  // 已经撑住 event loop，这个定时器不该再额外拖住退出。
  const armForceKill = () => {
    if (forceKillTimer !== undefined) {
      return;
    }
    forceKillTimer = setTimeout(() => {
      forceKilled = true;
      child.kill("SIGKILL");
    }, graceMilliseconds);
    forceKillTimer.unref();
  };
  const terminationRequested = Promise.withResolvers<never>();
  // participant 记录已收到、childHandshakeReady 还没置位的那段（addParticipant 与 ack 之间）里，
  // 下面的 race 早已结算，没人再等这个 promise；这条 catch 只为不让那时的 reject 变成 unhandled。
  void terminationRequested.promise.catch(() => undefined);
  const requestShutdown = (signal: NodeJS.Signals) => {
    queuedSignal ??= signal;
    if (!childHandshakeReady) {
      // 握手期不能直接转达：win32 的 requestShutdown 与下面的 participant 握手共用同一个 IPC
      // 收件箱，两边会互抢消息。这里只中止等待，杀子进程交给失败路径的 stopFailedChild。
      terminationRequested.reject(
        new TerminationRequestedError(`Production startup stopped by ${signal}.`),
      );
      return;
    }
    shutdownPromise ??= child.requestShutdown(queuedSignal);
    void shutdownPromise.catch(() => undefined);
    armForceKill();
  };
  const detachSignalHandlers = installTerminationSignalHandlers(requestShutdown);
  const onParentMessage = (message: unknown) => {
    if (!isShutdownRequestMessage(message)) {
      return;
    }
    input.state.parentShutdownRequestIds.push(message.requestId);
    requestShutdown(parentTerminationSignal);
  };
  const onParentDisconnect = () => {
    requestShutdown(parentTerminationSignal);
  };
  process.on("message", onParentMessage);
  process.on("disconnect", onParentDisconnect);
  input.state.detachSignals = () => {
    detachSignalHandlers();
    process.off("message", onParentMessage);
    process.off("disconnect", onParentDisconnect);
  };

  const participant = parseChildParticipantMessage(
    await Promise.race([nextMessage(child, 10_000), terminationRequested.promise]),
  );
  if (participant === undefined) {
    throw new Error("The production child sent an invalid lease participant record.");
  }
  await lease.addParticipant(participant);
  input.state.participantToken = participant.participantToken;
  await child.sendMessage({
    type: "reforce:lease-participant-ack",
    participantToken: participant.participantToken,
  });
  childHandshakeReady = true;
  if (queuedSignal !== undefined) {
    requestShutdown(queuedSignal);
  }

  try {
    const result = await child.wait();
    if (forceKilled) {
      throw new Error(
        `Production child did not exit within ${graceMilliseconds}ms of the shutdown request and was killed.`,
      );
    }
    await shutdownPromise;
    if (result.exitCode !== 0) {
      throw new Error(`Production child exited with code ${result.exitCode ?? "unknown"}.`);
    }
  } finally {
    clearTimeout(forceKillTimer);
  }
  return projectRoot;
}

async function stopFailedChild(
  child: ProductionChild | undefined,
  exitCode: 0 | 1,
  failures: unknown[],
): Promise<void> {
  if (exitCode === 0 || child === undefined) {
    return;
  }
  await captureFailure(async () => {
    child.kill("SIGKILL");
    await child.wait();
  }, failures);
}

async function releaseStartLease(
  state: StartCommandState,
  dependencies: StartCommandDependencies,
  failures: unknown[],
): Promise<void> {
  const lease = state.lease;
  if (lease === undefined) {
    return;
  }
  const participantToken = state.participantToken;
  if (participantToken !== undefined) {
    await captureFailure(() => dependencies.removeParticipant(lease, participantToken), failures);
  }
  await captureFailure(() => dependencies.releaseLease(lease), failures);
}

function acknowledgeParentRequests(
  requestIds: string[],
  ok: boolean,
  code: NonNullable<ShutdownAckMessage["code"]>,
): void {
  for (const requestId of requestIds.splice(0)) {
    if (ok) {
      process.send?.({
        type: "reforce:shutdown-ack",
        requestId,
        ok: true,
      } satisfies ShutdownAckMessage);
      continue;
    }
    process.send?.({
      type: "reforce:shutdown-ack",
      requestId,
      ok: false,
      code,
    } satisfies ShutdownAckMessage);
  }
}

async function finalizeStartCommand(input: {
  readonly reporter: Reporter;
  readonly dependencies: StartCommandDependencies;
  readonly state: StartCommandState;
  readonly exitCode: 0 | 1;
  readonly primaryFailures: readonly unknown[];
}): Promise<0 | 1> {
  const shutdownFailures: unknown[] = [];
  try {
    input.state.detachSignals();
  } catch (error) {
    shutdownFailures.push(error);
  }
  await stopFailedChild(input.state.child, input.exitCode, shutdownFailures);
  await captureFailure(() => input.reporter.flush(), shutdownFailures);
  await releaseStartLease(input.state, input.dependencies, shutdownFailures);
  if (shutdownFailures.length === 0) {
    acknowledgeParentRequests(
      input.state.parentShutdownRequestIds,
      input.exitCode === 0,
      "CHILD_FAILED",
    );
    return input.exitCode;
  }
  await reportShutdownFailure({
    reporter: input.reporter,
    command: "start",
    errors: [...input.primaryFailures, ...shutdownFailures],
  });
  acknowledgeParentRequests(input.state.parentShutdownRequestIds, false, "SHUTDOWN_FAILED");
  return 1;
}

export async function runStartCommand(
  options: StartCommandOptions,
  dependencyOverrides: Partial<StartCommandDependencies> = {},
): Promise<0 | 1> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const state: StartCommandState = {
    parentShutdownRequestIds: [],
    detachSignals: () => undefined,
  };
  let exitCode: 0 | 1 = 1;
  const primaryFailures: unknown[] = [];
  try {
    const projectRoot = await startProductionChild({ options, dependencies, state });
    options.reporter.report({
      kind: "success",
      command: "start",
      message: `Application stopped cleanly for ${projectRoot}.`,
    });
    exitCode = 0;
  } catch (error) {
    primaryFailures.push(error);
    reportStartFailure(options.reporter, error);
  }
  return await finalizeStartCommand({
    reporter: options.reporter,
    dependencies,
    state,
    exitCode,
    primaryFailures,
  });
}
