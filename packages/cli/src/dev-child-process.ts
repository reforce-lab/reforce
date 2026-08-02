import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isObject } from "radashi";
import type { DevChildExit, ManagedDevChild } from "#internal/dev-child-supervisor";
import { isDevChildLeaseParticipantMessage, isDevChildReadyMessage } from "#internal/dev-ipc";
import type { LeaseParticipant } from "#internal/project-lease";
import type { ShutdownAckMessage } from "#internal/shutdown-controller";

export interface SpawnDevChildOptions {
  readonly entryPath: string;
  readonly cwd: string;
  readonly nodeExecutable?: string;
  readonly nodeArguments?: readonly string[];
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

function isShutdownAcknowledgement(value: unknown, requestId: string): value is ShutdownAckMessage {
  if (!isObject(value)) {
    return false;
  }
  return (
    Reflect.get(value, "type") === "reforce:shutdown-ack" &&
    Reflect.get(value, "requestId") === requestId &&
    typeof Reflect.get(value, "ok") === "boolean"
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function waitForMessage<T>(
  child: ChildProcess,
  predicate: (message: unknown) => message is T,
  timeoutMilliseconds: number,
  timeoutMessage: string,
): Promise<T> {
  return withTimeout(
    new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        child.off("error", onError);
        child.off("exit", onExit);
        child.off("message", onMessage);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = () => {
        cleanup();
        reject(new Error("Development child exited before completing the IPC handshake."));
      };
      const onMessage = (message: unknown) => {
        if (!predicate(message)) {
          return;
        }
        cleanup();
        resolve(message);
      };
      child.on("error", onError);
      child.on("exit", onExit);
      child.on("message", onMessage);
    }),
    timeoutMilliseconds,
    timeoutMessage,
  );
}

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
  const child = spawn(
    options.nodeExecutable ?? process.execPath,
    [...(options.nodeArguments ?? []), options.entryPath, ...(options.applicationArguments ?? [])],
    {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
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
  let participantToken: string | undefined;
  let participantRegistered = false;
  let participantRemoval: Promise<void> | undefined;
  try {
    if (options.leaseParticipant) {
      const registration = await waitForMessage(
        child,
        isDevChildLeaseParticipantMessage,
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
      });
    }
    if (options.waitForReady) {
      await waitForMessage(
        child,
        isDevChildReadyMessage,
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
      const acknowledgement = waitForMessage(
        child,
        (message): message is ShutdownAckMessage => isShutdownAcknowledgement(message, requestId),
        options.ipcTimeoutMilliseconds ?? 5_000,
        "Development child did not acknowledge shutdown.",
      );
      await sendMessage(child, { type: "reforce:shutdown", requestId });
      const message = await acknowledgement;
      if (!isShutdownAcknowledgement(message, requestId) || !message.ok) {
        throw new Error("Development child reported shutdown failure.");
      }
    } catch (error) {
      terminateChild();
      await closed;
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

  function terminateChild(): void {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill(platform === "win32" ? undefined : "SIGKILL");
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
      terminateChild();
    } catch (error) {
      errors.push(error);
    }
    await closed;
    try {
      await removeParticipant();
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }
}
