import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isObject } from "radashi";
import { requireBunExecutable } from "@/bun-runtime";
import {
  isShutdownAcknowledgementMessage,
  isShutdownRequestMessage,
  type ShutdownAckMessage,
  type ShutdownRequestMessage,
} from "@/dev-ipc";
import { ProjectBusyError, ProjectLease } from "@/project/lease";
import type { LeaseParticipant } from "@/project/lease-endpoint";
import { createFailureEvent, type Reporter, reportShutdownFailure } from "@/reporter";

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
}

const defaultDependencies: StartCommandDependencies = {
  spawnChild: spawnProductionChild,
  releaseLease: (lease) => lease.release(),
  removeParticipant: (lease, participantToken) => lease.removeParticipant(participantToken),
};

class ArtifactInvalidError extends Error {
  readonly code = "ARTIFACT_INVALID" as const;

  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options);
    this.name = "ArtifactInvalidError";
  }
}

function assertContained(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot !== "" &&
    !isAbsolute(pathFromRoot) &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`)
  ) {
    return;
  }
  throw new Error(`Production entry resolves outside projectRoot: ${target}`);
}

function parseParticipant(value: unknown): LeaseParticipant | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const messageType = Reflect.get(value, "type");
  const participantValue = Reflect.get(value, "participant");
  if (messageType !== "reforce:lease-participant" || !isObject(participantValue)) {
    return undefined;
  }
  const participantToken = Reflect.get(participantValue, "participantToken");
  const host = Reflect.get(participantValue, "host");
  const port = Reflect.get(participantValue, "port");
  const challenge = Reflect.get(participantValue, "challenge");
  const role = Reflect.get(participantValue, "role");
  if (
    typeof participantToken !== "string" ||
    host !== "127.0.0.1" ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    typeof challenge !== "string" ||
    role !== "child"
  ) {
    return undefined;
  }
  return { participantToken, host, port, challenge, role };
}

interface ProductionChildResult {
  readonly exitCode?: number;
}

interface ProductionChild {
  getOneMessage(): Promise<unknown>;
  sendMessage(message: ShutdownRequestMessage | LeaseParticipantAck): Promise<void>;
  kill(signal: NodeJS.Signals): void;
  wait(): Promise<ProductionChildResult>;
}

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

async function nextMessage(child: ProductionChild, timeoutMilliseconds: number): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.getOneMessage(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("The production child IPC handshake timed out.")),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

// Windows has no POSIX signal semantics: `child.kill("SIGTERM")` there maps to TerminateProcess
// and the child gets no chance to shut down gracefully. On win32 shutdown must instead go through
// the IPC handshake (`reforce:shutdown` out, `reforce:shutdown-ack` back), so the child can run
// its own shutdown path; the `win32` branches in `startProductionChild` exist for the same reason.
async function requestWindowsShutdown(child: ProductionChild): Promise<void> {
  const requestId = randomUUID();
  await child.sendMessage({ type: "reforce:shutdown", requestId });
  for (;;) {
    const message = await nextMessage(child, 30_000);
    if (isShutdownAcknowledgementMessage(message) && message.requestId === requestId) {
      if (!message.ok) {
        throw new Error("The production child reported a shutdown failure.");
      }
      return;
    }
  }
}

async function resolveProjectRoot(projectDirectory: string): Promise<string> {
  const projectRoot = await realpath(projectDirectory);
  const rootMetadata = await lstat(projectRoot);
  if (!rootMetadata.isDirectory()) {
    throw new Error(`Project root is not a directory: ${projectDirectory}`);
  }
  return projectRoot;
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function assertNoIncompleteDistTransaction(projectRoot: string): Promise<void> {
  const transactionRoot = join(projectRoot, ".reforce", "transactions", "dist");
  try {
    const transactionEntries = await readdir(transactionRoot);
    if (transactionEntries.length > 0) {
      throw new ArtifactInvalidError(
        "Production artifact has an incomplete dist transaction; run reforce build to recover it.",
      );
    }
  } catch (error) {
    if (!isMissingPath(error)) {
      throw error;
    }
  }

  const projectEntries = await readdir(projectRoot);
  const transactionArtifact = projectEntries.find(
    (entry) => entry.startsWith("dist.staging-") || entry.startsWith("dist.backup-"),
  );
  if (transactionArtifact !== undefined) {
    throw new ArtifactInvalidError(
      `Production artifact has incomplete transaction output: ${transactionArtifact}`,
    );
  }
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
    if (!distMetadata.isDirectory() || distMetadata.isSymbolicLink()) {
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
  const busy = error instanceof ProjectBusyError;
  const artifactInvalid = error instanceof ArtifactInvalidError;
  let phase: "project" | "build" | "child" = "child";
  let code: "PROJECT_BUSY" | "ARTIFACT_INVALID" | "CHILD_FAILED" = "CHILD_FAILED";
  let message = "Production application failed.";
  if (busy) {
    phase = "project";
    code = "PROJECT_BUSY";
    message = error.message;
  } else if (artifactInvalid) {
    phase = "build";
    code = "ARTIFACT_INVALID";
    message = error.message;
  }
  reporter.report(
    createFailureEvent({
      command: "start",
      phase,
      fallbackCode: code,
      message,
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

  let shutdownPromise: Promise<void> | undefined;
  let childHandshakeReady = false;
  let queuedSignal: NodeJS.Signals | undefined;
  const requestShutdown = (signal: NodeJS.Signals) => {
    queuedSignal ??= signal;
    if (!childHandshakeReady) {
      return;
    }
    shutdownPromise ??=
      process.platform === "win32"
        ? requestWindowsShutdown(child)
        : Promise.resolve(child.kill(queuedSignal));
    void shutdownPromise.catch(() => undefined);
  };
  const signalNames: NodeJS.Signals[] =
    process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  const signalHandlers = signalNames.map((signal) => {
    const handler = () => requestShutdown(signal);
    process.on(signal, handler);
    return { signal, handler };
  });
  const onParentMessage = (message: unknown) => {
    if (!isShutdownRequestMessage(message)) {
      return;
    }
    input.state.parentShutdownRequestIds.push(message.requestId);
    requestShutdown(process.platform === "win32" ? "SIGBREAK" : "SIGTERM");
  };
  const onParentDisconnect = () => {
    requestShutdown(process.platform === "win32" ? "SIGBREAK" : "SIGTERM");
  };
  process.on("message", onParentMessage);
  process.on("disconnect", onParentDisconnect);
  input.state.detachSignals = () => {
    for (const { signal, handler } of signalHandlers) {
      process.off(signal, handler);
    }
    process.off("message", onParentMessage);
    process.off("disconnect", onParentDisconnect);
  };

  const participant = parseParticipant(await nextMessage(child, 10_000));
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

  const result = await child.wait();
  await shutdownPromise;
  if (result.exitCode !== 0) {
    throw new Error(`Production child exited with code ${result.exitCode ?? "unknown"}.`);
  }
  return projectRoot;
}

async function captureFailure(operation: () => Promise<void>, failures: unknown[]): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
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
