import type { ApplicationContext } from "@reforce/context";
import { isObject } from "radashi";
import { createChildLeaseParticipant } from "#internal/lease-endpoint";
import { PlainTextReporter, type Reporter, reportShutdownFailure } from "#internal/reporter";
import { installProcessShutdownHandlers, ShutdownController } from "#internal/shutdown-controller";

interface LeaseParticipantAck {
  readonly type: "reforce:lease-participant-ack";
  readonly participantToken: string;
}

function isLeaseParticipantAck(
  value: unknown,
  participantToken: string,
): value is LeaseParticipantAck {
  return (
    isObject(value) &&
    Reflect.get(value, "type") === "reforce:lease-participant-ack" &&
    Reflect.get(value, "participantToken") === participantToken
  );
}

async function waitForParticipantAck(participantToken: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.off("message", onMessage);
      reject(new Error("The production parent did not acknowledge the lease participant."));
    }, 5_000);
    const onMessage = (message: unknown) => {
      if (!isLeaseParticipantAck(message, participantToken)) {
        return;
      }
      clearTimeout(timeout);
      process.off("message", onMessage);
      resolve();
    };
    process.on("message", onMessage);
  });
}

type ChildLeaseParticipant = Awaited<ReturnType<typeof createChildLeaseParticipant>>;

export interface ProductionApplicationDependencies {
  readonly reporter: Reporter;
}

const defaultDependencies: ProductionApplicationDependencies = {
  reporter: new PlainTextReporter(),
};

async function joinParentLease(): Promise<ChildLeaseParticipant | undefined> {
  const leaseToken = process.env.REFORCE_LEASE_TOKEN;
  if (leaseToken === undefined) {
    return undefined;
  }
  if (typeof process.send !== "function") {
    throw new Error("A production child lease token requires Node IPC.");
  }
  const participant = await createChildLeaseParticipant(leaseToken);
  try {
    process.send({ type: "reforce:lease-participant", participant: participant.participant });
    await waitForParticipantAck(participant.participant.participantToken);
    return participant;
  } catch (error) {
    try {
      await participant.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Production lease handshake failed and cleanup also failed.",
        { cause: error },
      );
    }
    throw error;
  }
}

export async function runProductionApplication(
  bootstrap: () => Promise<ApplicationContext>,
  dependencies: ProductionApplicationDependencies = defaultDependencies,
): Promise<void> {
  const controller = new ShutdownController({
    command: "start",
    reporter: dependencies.reporter,
  });
  installProcessShutdownHandlers(controller);
  let participant: ChildLeaseParticipant | undefined;
  await controller.start(async () => {
    participant = await joinParentLease();
    const application = await bootstrap();
    return { close: () => application.close() };
  });
  const result = await controller.finished;
  try {
    await participant?.close();
  } catch (error) {
    await reportShutdownFailure({
      reporter: dependencies.reporter,
      command: "start",
      errors: [...result.errors, error],
    });
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.exitCode;
}
