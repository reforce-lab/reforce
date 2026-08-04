import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createSubprocessRegistry,
  createTimeoutGuard,
  observeTypedMessages,
  resolveBunExecutable,
  send,
} from "@reforce/tooling-testing";
import { type LeaseParticipant, probeLeaseEndpoint } from "@/lease-endpoint";
import { parseLeaseParticipant } from "../support/process/lease-participant";

const harnessPath = fileURLToPath(
  new URL("../support/process/production/production-runtime-order.harness.ts", import.meta.url),
);
const windowsSignalHarnessPath = fileURLToPath(
  import.meta.resolve("@reforce/tooling-testing/windows-signal-harness"),
);
const bunExecutable = await resolveBunExecutable();
const subprocesses = createSubprocessRegistry();
const withTimeout = createTimeoutGuard(2_000);

afterEach(subprocesses.killAll);

function parseParticipant(message: unknown): LeaseParticipant | undefined {
  if (!hasMessageType(message, "reforce:lease-participant")) {
    return undefined;
  }
  return parseLeaseParticipant(Reflect.get(message, "participant"));
}

function hasMessageType(message: unknown, type: string): message is object {
  return typeof message === "object" && message !== null && Reflect.get(message, "type") === type;
}

interface ObservedProductionHarness {
  readonly child: ChildProcess;
  readonly completion: Promise<number | null>;
  readonly participant: Promise<LeaseParticipant>;
  readonly runtimeReady: Promise<void>;
  readonly applicationClosed: Promise<void>;
  readonly flushEntered: Promise<void>;
  readonly signalObserved: Promise<void>;
  readonly shutdownAcknowledged: Promise<void>;
  readonly returned: Promise<void>;
  readonly messageCount: (type: string) => number;
  barrier(): Promise<void>;
}

function spawnObservedProductionHarness(
  useWindowsSignalHarness: boolean,
): ObservedProductionHarness {
  const leaseToken = randomBytes(32).toString("hex");
  const participant = Promise.withResolvers<LeaseParticipant>();
  const runtimeReady = Promise.withResolvers<void>();
  const applicationClosed = Promise.withResolvers<void>();
  const flushEntered = Promise.withResolvers<void>();
  const signalObserved = Promise.withResolvers<void>();
  const shutdownAcknowledged = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  const child = spawn(
    bunExecutable,
    useWindowsSignalHarness ? [windowsSignalHarnessPath, harnessPath] : [harnessPath],
    {
      env: { ...process.env, REFORCE_LEASE_TOKEN: leaseToken },
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const observer = observeTypedMessages({
    child,
    withTimeout,
    barrierTimeoutMessage: "Production harness barrier timed out.",
    consume(message) {
      const leaseParticipant = parseParticipant(message);
      if (leaseParticipant === undefined) {
        return false;
      }
      participant.resolve(leaseParticipant);
      return true;
    },
    handlers: new Map([
      ["harness:ready", () => runtimeReady.resolve()],
      ["harness:application-closed", () => applicationClosed.resolve()],
      ["harness:flush-entered", () => flushEntered.resolve()],
      ["harness:signal-observed", () => signalObserved.resolve()],
      ["reforce:shutdown-ack", () => shutdownAcknowledged.resolve()],
      ["harness:returned", () => returned.resolve()],
    ]),
  });
  subprocesses.track(child, completion);
  return {
    child,
    completion,
    participant: participant.promise,
    runtimeReady: runtimeReady.promise,
    applicationClosed: applicationClosed.promise,
    flushEntered: flushEntered.promise,
    signalObserved: signalObserved.promise,
    shutdownAcknowledged: shutdownAcknowledged.promise,
    returned: returned.promise,
    messageCount: observer.messageCount,
    barrier: observer.barrier,
  };
}

test("production keeps its lease participant live through application cleanup and reporter flush", async () => {
  const leaseToken = randomBytes(32).toString("hex");
  const participantReady = Promise.withResolvers<LeaseParticipant>();
  const runtimeReady = Promise.withResolvers<void>();
  const applicationClosed = Promise.withResolvers<void>();
  const flushEntered = Promise.withResolvers<void>();
  const shutdownAcknowledged = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  const events: string[] = [];
  const child = spawn(bunExecutable, [harnessPath], {
    env: { ...process.env, REFORCE_LEASE_TOKEN: leaseToken },
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  child.on("message", (message: unknown) => {
    const participant = parseParticipant(message);
    if (participant !== undefined) {
      participantReady.resolve(participant);
      return;
    }
    if (hasMessageType(message, "harness:ready")) {
      runtimeReady.resolve();
      return;
    }
    if (hasMessageType(message, "harness:application-closed")) {
      events.push("application-close");
      applicationClosed.resolve();
      return;
    }
    if (hasMessageType(message, "harness:flush-entered")) {
      events.push("reporter-flush");
      flushEntered.resolve();
      return;
    }
    if (hasMessageType(message, "reforce:shutdown-ack")) {
      events.push("shutdown-ack");
      shutdownAcknowledged.resolve();
      return;
    }
    if (hasMessageType(message, "harness:returned")) {
      events.push("runtime-returned");
      returned.resolve();
    }
  });
  subprocesses.track(child, completion);
  const participant = await withTimeout(
    participantReady.promise,
    "Production harness did not publish a participant.",
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  await send(child, {
    type: "reforce:lease-participant-ack",
    participantToken: participant.participantToken,
  });
  await withTimeout(runtimeReady.promise, "Production harness did not bootstrap.");
  await send(child, { type: "reforce:shutdown", requestId: randomUUID() });
  await withTimeout(applicationClosed.promise, "Production harness did not close its application.");
  await withTimeout(flushEntered.promise, "Production harness did not flush its reporter.");

  expect(await probeLeaseEndpoint(participant, leaseToken, 500)).toBe("live");

  await send(child, { type: "harness:continue-flush" });
  await withTimeout(
    shutdownAcknowledged.promise,
    "Production harness did not acknowledge shutdown.",
  );
  await withTimeout(returned.promise, "Production runtime did not return.");
  expect(await withTimeout(completion, "Production harness did not exit.")).toBe(0);
  subprocesses.forget(child);

  expect(events).toEqual([
    "application-close",
    "reporter-flush",
    "shutdown-ack",
    "runtime-returned",
  ]);
  expect(await probeLeaseEndpoint(participant, leaseToken, 500)).toBe("dead");
}, 15_000);

test("production queues parent IPC shutdown while the lease acknowledgement is delayed", async () => {
  const harness = spawnObservedProductionHarness(false);
  const participant = await withTimeout(
    harness.participant,
    "Production harness did not publish a participant.",
  );
  const requestId = randomUUID();

  await send(harness.child, { type: "reforce:shutdown", requestId });
  await harness.barrier();
  await send(harness.child, {
    type: "reforce:lease-participant-ack",
    participantToken: participant.participantToken,
  });
  await withTimeout(harness.runtimeReady, "Production harness did not bootstrap.");
  await withTimeout(
    harness.applicationClosed,
    "Production harness did not close after queued IPC shutdown.",
  );
  await withTimeout(harness.flushEntered, "Production harness did not flush after IPC shutdown.");
  await send(harness.child, { type: "harness:continue-flush" });
  await withTimeout(
    harness.shutdownAcknowledged,
    "Production harness did not acknowledge queued IPC shutdown.",
  );
  await withTimeout(harness.returned, "Production runtime did not return after IPC shutdown.");
  expect(await withTimeout(harness.completion, "Production harness did not exit.")).toBe(0);
  subprocesses.forget(harness.child);

  expect(harness.messageCount("harness:application-closed")).toBe(1);
  expect(harness.messageCount("reforce:shutdown-ack")).toBe(1);
}, 15_000);

test("production queues a platform signal while the lease acknowledgement is delayed", async () => {
  const harness = spawnObservedProductionHarness(process.platform === "win32");
  const participant = await withTimeout(
    harness.participant,
    "Production harness did not publish a participant.",
  );

  if (process.platform === "win32") {
    await send(harness.child, { type: "reforce:e2e-signal", signal: "SIGINT" });
  } else if (!harness.child.kill("SIGINT")) {
    throw new Error("Unable to deliver SIGINT to the production harness.");
  }
  await withTimeout(harness.signalObserved, "Production harness did not observe SIGINT.");
  await send(harness.child, {
    type: "reforce:lease-participant-ack",
    participantToken: participant.participantToken,
  });
  await withTimeout(harness.runtimeReady, "Production harness did not bootstrap.");
  await withTimeout(
    harness.applicationClosed,
    "Production harness did not close after queued SIGINT.",
  );
  await withTimeout(harness.flushEntered, "Production harness did not flush after SIGINT.");
  await send(harness.child, { type: "harness:continue-flush" });
  await withTimeout(harness.returned, "Production runtime did not return after SIGINT.");
  expect(await withTimeout(harness.completion, "Production harness did not exit.")).toBe(0);
  subprocesses.forget(harness.child);

  expect(harness.messageCount("harness:application-closed")).toBe(1);
  expect(harness.messageCount("harness:signal-observed")).toBe(1);
}, 15_000);
