import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DevChildExit, ManagedDevChild } from "@/dev/child-supervisor";
import {
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
        ...(signalName === null ? {} : { signalName }),
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
        options.ipcTimeoutMilliseconds ?? 5_000,
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
      await withTimeout(
        ready.promise,
        options.ipcTimeoutMilliseconds ?? 5_000,
        "Development child did not report readiness.",
      );
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
    requestShutdown(signal) {
      shutdownPromise ??=
        platform === "win32" ? requestIpcShutdown() : requestPosixShutdown(signal ?? "SIGTERM");
      return shutdownPromise;
    },
  };

  async function requestIpcShutdown(): Promise<void> {
    try {
      const requestId = randomUUID();
      const acknowledgement = waitForShutdownAcknowledgement(
        requestId,
        options.ipcTimeoutMilliseconds ?? 5_000,
      );
      void acknowledgement.catch(() => undefined);
      await sendMessage(child, {
        type: "reforce:shutdown",
        requestId,
      } satisfies ShutdownRequestMessage);
      const message = await acknowledgement;
      if (!message.ok) {
        throw new Error("Development child reported shutdown failure.");
      }
    } catch (error) {
      try {
        await terminateChildAndWait();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Development child shutdown and termination both failed.",
          { cause: error },
        );
      }
      const result = await exited;
      if (result.error === undefined) {
        throw error;
      }
      throw new AggregateError(
        [error, result.error],
        "Development child shutdown and cleanup both failed.",
        { cause: error },
      );
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
        options.ipcTimeoutMilliseconds ?? 5_000,
        "Development child did not exit after forced termination.",
      );
    } catch (error) {
      throwTerminationFailure(terminationError, error, detachChildHandle());
    }
  }

  function forceTerminateChild(): unknown | undefined {
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
    terminationError: unknown | undefined,
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
