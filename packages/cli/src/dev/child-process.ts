import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DevChildExit, ManagedDevChild } from "@/dev/child-supervisor";
import {
  type DevBuildReadyMessage,
  type DevChildLeaseParticipantAcknowledgement,
  type DevChildLeaseParticipantMessage,
  type DevChildReadyMessage,
  isDevChildLeaseParticipantMessage,
  isDevChildReadyMessage,
  isShutdownAcknowledgementMessage,
  type ShutdownAckMessage,
  type ShutdownRequestMessage,
} from "@/dev-ipc";
import type { LeaseParticipant } from "@/project/lease-endpoint";
import { withTimeout } from "@/with-timeout";

export interface SpawnDevChildOptions {
  readonly entryPath: string;
  readonly cwd: string;
  readonly bunExecutable?: string;
  readonly applicationArguments?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly ipcTimeoutMilliseconds?: number;
  readonly waitForReady?: boolean;
  readonly leaseParticipant?: {
    add(participant: LeaseParticipant): Promise<void>;
    remove(participantToken: string): Promise<void>;
  };
}

type ShutdownAcknowledgementWaiter = ReturnType<typeof Promise.withResolvers<ShutdownAckMessage>>;

function sendMessage(child: ChildProcess, message: object): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.send(message, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function spawnDevChild(options: SpawnDevChildOptions): Promise<ManagedDevChild> {
  const platform = options.platform ?? process.platform;
  const participant = Promise.withResolvers<DevChildLeaseParticipantMessage>();
  const ready = Promise.withResolvers<DevChildReadyMessage>();
  const acknowledgements = new Map<string, ShutdownAcknowledgementWaiter>();
  let ipcClosedError: Error | undefined;
  // Attach rejection handlers up front: if the child exits before these promises are awaited,
  // their rejection must not surface as an unhandled rejection.
  void participant.promise.catch(() => undefined);
  void ready.promise.catch(() => undefined);
  const onMessage = (message: unknown) => {
    if (isDevChildLeaseParticipantMessage(message)) {
      participant.resolve(message);
      return;
    }
    if (isDevChildReadyMessage(message)) {
      ready.resolve(message);
      return;
    }
    if (!isShutdownAcknowledgementMessage(message)) {
      return;
    }
    const waiter = acknowledgements.get(message.requestId);
    if (waiter !== undefined) {
      acknowledgements.delete(message.requestId);
      waiter.resolve(message);
    }
  };
  // 一次解析：下面四个等待点（participant / ready / shutdown ack / 强杀后退出）共用同一个上限，
  // 各写各的 `?? 5_000` 意味着调整默认值时会漏掉其中几处。
  const ipcTimeout = options.ipcTimeoutMilliseconds ?? 5_000;
  const child = spawn(
    options.bunExecutable ?? process.execPath,
    [options.entryPath, ...(options.applicationArguments ?? [])],
    {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  child.on("message", onMessage);
  const baseExited = new Promise<DevChildExit>((resolve) => {
    child.once("error", (error) => resolve({ exitCode: null, error }));
    child.once("exit", (exitCode, signalName) =>
      resolve({
        exitCode,
        signalName: signalName ?? undefined,
      }),
    );
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  // Once the child exits the IPC channel is dead; settle every pending handshake and shutdown
  // acknowledgement with the same error so no waiter hangs until its own timeout fires.
  void baseExited.then((result) => {
    const error =
      result.error instanceof Error
        ? result.error
        : new Error("Development child exited before completing the IPC handshake.");
    ipcClosedError = error;
    child.off("message", onMessage);
    participant.reject(error);
    ready.reject(error);
    for (const waiter of acknowledgements.values()) {
      waiter.reject(error);
    }
    acknowledgements.clear();
  });
  let participantToken: string | undefined;
  let participantRegistered = false;
  let participantRemoval: Promise<void> | undefined;
  try {
    if (options.leaseParticipant) {
      const registration = await withTimeout(
        participant.promise,
        ipcTimeout,
        "Development child did not publish its lease participant.",
      );
      participantToken = registration.participant.participantToken;
      await options.leaseParticipant.add(registration.participant);
      participantRegistered = true;
      await sendMessage(child, {
        type: "reforce:lease-participant-ack",
        participantToken,
        ok: true,
      } satisfies DevChildLeaseParticipantAcknowledgement);
    }
    if (options.waitForReady) {
      await withTimeout(ready.promise, ipcTimeout, "Development child did not report readiness.");
    }
  } catch (error) {
    const cleanupErrors = await cleanupFailedChild();
    if (cleanupErrors.length === 0) {
      throw error;
    }
    throw new AggregateError(
      [error, ...cleanupErrors],
      "Development child startup and cleanup both failed.",
      { cause: error },
    );
  }
  const exited = baseExited.then(async (result) => {
    try {
      await removeParticipant();
      return result;
    } catch (error) {
      const primaryError = result.error;
      return {
        ...result,
        error:
          primaryError === undefined
            ? error
            : new AggregateError(
                [primaryError, error],
                "Development child exit and lease cleanup both failed.",
                { cause: primaryError },
              ),
      };
    }
  });
  let shutdownPromise: Promise<void> | undefined;
  return {
    exited,
    async notifyBuildReady(buildId) {
      // A child that already exited or lost its channel is not a failure here: the supervisor
      // observes the exit separately and respawns on the current build.
      if (ipcClosedError !== undefined || !child.connected) {
        return;
      }
      await sendMessage(child, {
        type: "reforce:dev-build-ready",
        buildId,
      } satisfies DevBuildReadyMessage);
    },
    requestShutdown(signal) {
      shutdownPromise ??=
        platform === "win32" ? requestIpcShutdown() : requestPosixShutdown(signal ?? "SIGTERM");
      return shutdownPromise;
    },
  };

  // 判据是子进程的退出码，不是 ack：`exit` 一到就会取消所有 ack waiter 并摘掉 message
  // 监听器，而 `exit` 不代表 IPC 通道已排空（`close` 才是）。所以跑完关闭流程、干净退出的
  // 子进程不得因为 ack 丢失或迟到被判成关闭失败；ack 只用来解释失败原因（Issue #32）。
  async function requestIpcShutdown(): Promise<void> {
    const reason = await requestShutdownAcknowledgement();
    if (reason === undefined) {
      return;
    }
    try {
      await terminateChildAndWait();
    } catch (cleanupError) {
      throw new AggregateError(
        [reason, cleanupError],
        "Development child shutdown and termination both failed.",
        { cause: reason },
      );
    }
    const result = await exited;
    if (result.exitCode === 0 && result.error === undefined) {
      return;
    }
    if (result.error === undefined) {
      throw reason;
    }
    throw new AggregateError(
      [reason, result.error],
      "Development child shutdown and cleanup both failed.",
      { cause: reason },
    );
  }

  // 返回 undefined 表示子进程确认关闭成功；否则返回失败原因。握手丢失与子进程自报失败
  // 用不同文案，一行 stderr 就能区分（Issue #32）。
  async function requestShutdownAcknowledgement(): Promise<Error | undefined> {
    try {
      const requestId = randomUUID();
      const acknowledgement = waitForShutdownAcknowledgement(requestId, ipcTimeout);
      void acknowledgement.catch(() => undefined);
      await sendMessage(child, {
        type: "reforce:shutdown",
        requestId,
      } satisfies ShutdownRequestMessage);
      const message = await acknowledgement;
      if (message.ok) {
        return undefined;
      }
      return new Error("Development child reported a failed shutdown.");
    } catch (error) {
      return new Error("Development child shutdown handshake failed.", { cause: error });
    }
  }

  async function requestPosixShutdown(signal: NodeJS.Signals): Promise<void> {
    if (!child.kill(signal)) {
      await exited;
    }
  }

  function waitForShutdownAcknowledgement(
    requestId: string,
    timeoutMilliseconds: number,
  ): Promise<ShutdownAckMessage> {
    if (ipcClosedError !== undefined) {
      return Promise.reject(ipcClosedError);
    }
    const completion = Promise.withResolvers<ShutdownAckMessage>();
    acknowledgements.set(requestId, completion);
    return withTimeout(
      completion.promise,
      timeoutMilliseconds,
      "Development child did not acknowledge shutdown.",
    ).finally(() => acknowledgements.delete(requestId));
  }

  async function terminateChildAndWait(): Promise<void> {
    const terminationError = forceTerminateChild();
    try {
      await withTimeout(
        closed,
        ipcTimeout,
        "Development child did not exit after forced termination.",
      );
    } catch (error) {
      throwTerminationFailure(terminationError, error, detachChildHandle());
    }
  }

  function forceTerminateChild(): unknown {
    if (child.exitCode !== null || child.signalCode !== null) {
      return undefined;
    }
    try {
      return child.kill(platform === "win32" ? undefined : "SIGKILL")
        ? undefined
        : new Error("Development child rejected forced termination.");
    } catch (error) {
      return error;
    }
  }

  function throwTerminationFailure(
    terminationError: unknown,
    exitError: unknown,
    detachmentErrors: readonly unknown[],
  ): never {
    const errors = [
      ...(terminationError === undefined ? [] : [terminationError]),
      exitError,
      ...detachmentErrors,
    ];
    if (errors.length === 1) {
      throw exitError;
    }
    throw new AggregateError(errors, "Development child termination failed.", {
      cause: terminationError ?? exitError,
    });
  }

  function detachChildHandle(): readonly unknown[] {
    const errors: unknown[] = [];
    child.off("message", onMessage);
    try {
      if (child.connected) {
        child.disconnect();
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      child.unref();
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }

  function removeParticipant(): Promise<void> {
    if (!participantRegistered || !participantToken || !options.leaseParticipant) {
      return Promise.resolve();
    }
    participantRemoval ??= options.leaseParticipant.remove(participantToken);
    return participantRemoval;
  }

  async function cleanupFailedChild(): Promise<readonly unknown[]> {
    const errors: unknown[] = [];
    try {
      await terminateChildAndWait();
    } catch (error) {
      errors.push(error);
      return errors;
    }
    try {
      await removeParticipant();
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }
}
