import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveBunExecutable } from "@reforce/tooling-testing";
import { type LeaseParticipant, probeLeaseEndpoint } from "@/project/lease-endpoint";

const harnessPath = fileURLToPath(
  new URL("../support/process/production/production-runtime-order.harness.ts", import.meta.url),
);
const windowsSignalHarnessPath = fileURLToPath(
  new URL("../support/process/windows-signal.harness.ts", import.meta.url),
);
const bunExecutable = await resolveBunExecutable();
const subprocesses: Array<{
  readonly child: ChildProcess;
  readonly completion: Promise<number | null>;
}> = [];

afterEach(async () => {
  for (const subprocess of subprocesses.splice(0).reverse()) {
    subprocess.child.kill();
    await subprocess.completion.catch(() => undefined);
  }
});

function parseParticipant(message: unknown): LeaseParticipant | undefined {
  if (
    typeof message !== "object" ||
    message === null ||
    Reflect.get(message, "type") !== "reforce:lease-participant"
  ) {
    return undefined;
  }
  const value = Reflect.get(message, "participant");
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const participantToken = Reflect.get(value, "participantToken");
  const host = Reflect.get(value, "host");
  const port = Reflect.get(value, "port");
  const challenge = Reflect.get(value, "challenge");
  const role = Reflect.get(value, "role");
  if (
    typeof participantToken !== "string" ||
    host !== "127.0.0.1" ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    typeof challenge !== "string" ||
    role !== "child"
  ) {
    return undefined;
  }
  return { participantToken, host, port, challenge, role };
}

function hasMessageType(message: unknown, type: string): boolean {
  return typeof message === "object" && message !== null && Reflect.get(message, "type") === type;
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 2_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function send(child: ChildProcess, message: object): Promise<void> {
  if (child.send === undefined) {
    throw new Error("Production harness has no IPC channel.");
  }
  await new Promise<void>((resolve, reject) => {
    child.send?.(message, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
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
  const barriers = new Map<string, () => void>();
  const counts = new Map<string, number>();
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
  const messageHandlers = new Map<string, (message: object) => void>([
    ["harness:ready", () => runtimeReady.resolve()],
    ["harness:application-closed", () => applicationClosed.resolve()],
    ["harness:flush-entered", () => flushEntered.resolve()],
    ["harness:signal-observed", () => signalObserved.resolve()],
    ["reforce:shutdown-ack", () => shutdownAcknowledged.resolve()],
    ["harness:returned", () => returned.resolve()],
    [
      "harness:barrier-ack",
      (message) => {
        const requestId = Reflect.get(message, "requestId");
        if (typeof requestId === "string") {
          barriers.get(requestId)?.();
          barriers.delete(requestId);
        }
      },
    ],
  ]);
  child.on("message", (message: unknown) => {
    const leaseParticipant = parseParticipant(message);
    if (leaseParticipant !== undefined) {
      participant.resolve(leaseParticipant);
      return;
    }
    if (typeof message !== "object" || message === null) {
      return;
    }
    const type = Reflect.get(message, "type");
    if (typeof type !== "string") {
      return;
    }
    counts.set(type, (counts.get(type) ?? 0) + 1);
    messageHandlers.get(type)?.(message);
  });
  subprocesses.push({ child, completion });
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
    messageCount: (type) => counts.get(type) ?? 0,
    async barrier() {
      const requestId = randomUUID();
      const acknowledgement = Promise.withResolvers<void>();
      barriers.set(requestId, acknowledgement.resolve);
      await send(child, { type: "harness:barrier", requestId });
      await withTimeout(acknowledgement.promise, "Production harness barrier timed out.");
    },
  };
}

function forgetSubprocess(child: ChildProcess): void {
  const index = subprocesses.findIndex((subprocess) => subprocess.child === child);
  if (index >= 0) {
    subprocesses.splice(index, 1);
  }
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
  subprocesses.push({ child, completion });
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
  subprocesses.splice(
    subprocesses.findIndex((subprocess) => subprocess.child === child),
    1,
  );

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
  forgetSubprocess(harness.child);

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
  forgetSubprocess(harness.child);

  expect(harness.messageCount("harness:application-closed")).toBe(1);
  expect(harness.messageCount("harness:signal-observed")).toBe(1);
}, 15_000);
