import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { requireBunExecutable } from "@reforce/runtime/bun-runtime";
import { isShutdownRequestMessage, type ShutdownAckMessage } from "@reforce/runtime/dev-ipc";
import type { LeaseParticipant } from "@reforce/runtime/lease-endpoint";
import { installTerminationSignalHandlers } from "@reforce/runtime/process-signals";
import {
  captureFailure,
  createFailureEvent,
  type Reporter,
  reportShutdownFailure,
} from "@reforce/runtime/reporter";
import { isObject } from "radashi";
import { ProjectBusyError, ProjectLease, parseParticipant } from "@/project/lease";
import { ArtifactInvalidError, resolveProductionEntry } from "@/start/artifact";
import { nextMessage, type ProductionChild, spawnProductionChild } from "@/start/child-process";

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

// 握手完成前收到终止信号时用它中止等待，而不是把信号排队到握手结束（Issue #103）。
class TerminationRequestedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminationRequestedError";
  }
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

// 父进程转达的默认终止信号。Windows 上没有 SIGTERM，取 SIGBREAK（与 process-signals 所监听的一致）。
const parentTerminationSignal: NodeJS.Signals =
  process.platform === "win32" ? "SIGBREAK" : "SIGTERM";

async function resolveProjectRoot(projectDirectory: string): Promise<string> {
  const projectRoot = await realpath(projectDirectory);
  const rootMetadata = await lstat(projectRoot);
  if (!rootMetadata.isDirectory()) {
    throw new Error(`Project root is not a directory: ${projectDirectory}`);
  }
  return projectRoot;
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
