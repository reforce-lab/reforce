import { requireBunExecutable } from "@/bun-runtime";
import { DevEntryController } from "@/dev-entry";
import type { RspackHmrRuntime } from "@/dev-hmr-manager";
import {
  type DevChildLeaseParticipantMessage,
  type DevChildReadyMessage,
  isDevChildLeaseParticipantAcknowledgement,
  writerLeaseTokenEnvironmentVariable,
} from "@/dev-ipc";
import { createChildLeaseParticipant } from "@/lease-endpoint";
import { PlainTextReporter, reportShutdownFailure } from "@/reporter";
import type { ShutdownResult } from "@/shutdown-controller";
import { withTimeout } from "@/with-timeout";

export interface DevelopmentBootstrapModule {
  bootstrap(): Promise<{ close(): Promise<void> }>;
}

export interface RunDevelopmentApplicationOptions {
  readonly hot: RspackHmrRuntime;
  readonly loadBootstrap: () => Promise<DevelopmentBootstrapModule>;
  readonly ipcTimeoutMilliseconds?: number;
}

// rspack keeps only the latest compilation's hot-update output, so the manifest for the hash
// this client last saw can be gone after a rebuild and check() then fails with a 404-like error.
// Swallowing it as "no update" keeps polling alive; any other failure must propagate because
// DevHmrManager treats a rejected check as fatal and shuts the child down.
function isMissingHotUpdateManifest(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const locations = [
    Reflect.get(error, "url"),
    Reflect.get(error, "path"),
    Reflect.get(error, "message"),
  ];
  return locations.some(
    (location) =>
      typeof location === "string" &&
      /(?:^|\/)updates\/[^/]+\.hot-update\.json(?:\b|["'])/u.test(location.replaceAll("\\", "/")),
  );
}

export function createRspackHmrRuntime(hot: RspackHmrRuntime): RspackHmrRuntime {
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

function sendToParent(message: object): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!process.send) {
      reject(new Error("Development child requires a Bun process IPC channel."));
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
  requireBunExecutable();
  const reporter = new PlainTextReporter();
  const leaseToken = process.env[writerLeaseTokenEnvironmentVariable];
  let endpoint: Awaited<ReturnType<typeof createChildLeaseParticipant>> | undefined;
  let participantRegistered = false;

  const joinWriterLease = async () => {
    if (participantRegistered) {
      return;
    }
    if (!leaseToken) {
      throw new Error("Development child did not receive its writer lease identity.");
    }
    endpoint = await createChildLeaseParticipant(leaseToken);
    const acknowledgement = waitForParticipantAcknowledgement(
      endpoint.participant.participantToken,
      options.ipcTimeoutMilliseconds ?? 5_000,
    );
    await sendToParent({
      type: "reforce:lease-participant",
      participant: endpoint.participant,
    } satisfies DevChildLeaseParticipantMessage);
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
        await sendToParent({ type: "reforce:dev-ready" } satisfies DevChildReadyMessage);
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
  // Yield one event-loop tick so IPC messages already sent (dev-ready, lease registration)
  // flush to the parent before the channel is disconnected.
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (process.connected) {
    process.disconnect?.();
  }
  return exitCode;
}
