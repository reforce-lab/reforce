import {
  createDevChildLeaseEndpoint,
  type DevChildLeaseEndpoint,
} from "#internal/dev-child-liveness";
import { DevEntryController } from "#internal/dev-entry";
import type { NodeHmrRuntime } from "#internal/dev-hmr-manager";
import {
  isDevChildLeaseParticipantAcknowledgement,
  writerLeaseTokenEnvironmentVariable,
} from "#internal/dev-ipc";
import { PlainTextReporter, reportShutdownFailure } from "#internal/reporter";
import type { ShutdownResult } from "#internal/shutdown-controller";

export interface DevelopmentBootstrapModule {
  bootstrap(): Promise<{ close(): Promise<void> }>;
}

export interface RunDevelopmentApplicationOptions {
  readonly hot: NodeHmrRuntime;
  readonly loadBootstrap: () => Promise<DevelopmentBootstrapModule>;
  readonly ipcTimeoutMilliseconds?: number;
}

function isMissingHotUpdateManifest(error: unknown): boolean {
  if (!(error instanceof Error) || Reflect.get(error, "code") !== "ERR_MODULE_NOT_FOUND") {
    return false;
  }
  const url = Reflect.get(error, "url");
  if (typeof url !== "string") {
    return false;
  }
  try {
    return /\/updates\/[^/]+\.hot-update\.json$/u.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function createRspackNodeHmrRuntime(hot: NodeHmrRuntime): NodeHmrRuntime {
  return {
    accept(specifier) {
      hot.accept(specifier);
    },
    async check(autoApply) {
      try {
        return await hot.check(autoApply);
      } catch (error) {
        if (isMissingHotUpdateManifest(error)) {
          return null;
        }
        throw error;
      }
    },
    async apply() {
      return await hot.apply();
    },
  };
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function sendToParent(message: object): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!process.send) {
      reject(new Error("Development child requires a Node IPC channel."));
      return;
    }
    process.send(message, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function waitForParticipantAcknowledgement(
  participantToken: string,
  timeoutMilliseconds: number,
): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        process.off("disconnect", onDisconnect);
        process.off("message", onMessage);
      };
      const onDisconnect = () => {
        cleanup();
        reject(new Error("Development parent disconnected during lease registration."));
      };
      const onMessage = (message: unknown) => {
        if (!isDevChildLeaseParticipantAcknowledgement(message, participantToken)) {
          return;
        }
        cleanup();
        if (!message.ok) {
          reject(new Error("Development parent rejected the child lease participant."));
          return;
        }
        resolve();
      };
      process.on("disconnect", onDisconnect);
      process.on("message", onMessage);
    }),
    timeoutMilliseconds,
    "Development parent did not acknowledge the child lease participant.",
  );
}

export async function runDevelopmentApplication(
  options: RunDevelopmentApplicationOptions,
): Promise<0 | 1> {
  const reporter = new PlainTextReporter();
  const leaseToken = process.env[writerLeaseTokenEnvironmentVariable];
  let endpoint: DevChildLeaseEndpoint | undefined;
  let participantRegistered = false;

  const joinWriterLease = async () => {
    if (participantRegistered) {
      return;
    }
    if (!leaseToken) {
      throw new Error("Development child did not receive its writer lease identity.");
    }
    endpoint = await createDevChildLeaseEndpoint(leaseToken);
    const acknowledgement = waitForParticipantAcknowledgement(
      endpoint.participant.participantToken,
      options.ipcTimeoutMilliseconds ?? 5_000,
    );
    await sendToParent({
      type: "reforce:lease-participant",
      participant: endpoint.participant,
    });
    await acknowledgement;
    participantRegistered = true;
  };

  const entry = new DevEntryController({
    hot: options.hot,
    reporter,
    bootstrap: async () => {
      await joinWriterLease();
      const module = await options.loadBootstrap();
      return await module.bootstrap();
    },
  });

  const runEntry = async (): Promise<ShutdownResult> => {
    try {
      await entry.start();
      if (entry.state === "running") {
        await sendToParent({ type: "reforce:dev-ready" });
      }
      return await entry.finished;
    } catch (error) {
      return await entry.requestShutdown({
        error,
        code: "BOOTSTRAP_FAILED",
        phase: "bootstrap",
        message: "Development child bootstrap failed.",
      });
    }
  };

  const result = await runEntry();
  let exitCode = result.exitCode;
  try {
    await endpoint?.close();
  } catch (error) {
    await reportShutdownFailure({
      reporter,
      command: "dev",
      errors: [...result.errors, error],
    });
    exitCode = 1;
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (process.connected) {
    process.disconnect?.();
  }
  return exitCode;
}
