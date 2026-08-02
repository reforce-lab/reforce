import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveBunExecutable, runCommand } from "@reforce/tooling-testing";
import {
  isDevChildLeaseParticipantMessage,
  isDevChildReadyMessage,
  writerLeaseTokenEnvironmentVariable,
} from "@/dev-ipc";

const harnessPath = fileURLToPath(
  new URL("../support/process/dev/dev-entry.harness.ts", import.meta.url),
);
const bootstrapFailureHarnessPath = fileURLToPath(
  new URL("../support/process/dev/dev-runtime-bootstrap.harness.ts", import.meta.url),
);
const handshakeHarnessPath = fileURLToPath(
  new URL("../support/process/dev/dev-runtime-handshake.harness.ts", import.meta.url),
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

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 5_000);
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
    throw new Error("Development harness has no IPC channel.");
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

interface ObservedDevelopmentHarness {
  readonly child: ChildProcess;
  readonly completion: Promise<number | null>;
  readonly participant: Promise<ReturnType<typeof requireParticipant>>;
  readonly bootstrap: Promise<void>;
  readonly closed: Promise<void>;
  readonly shutdownAcknowledged: Promise<void>;
  readonly signalObserved: Promise<void>;
  readonly messageCount: (type: string) => number;
  barrier(): Promise<void>;
}

function requireParticipant(message: unknown) {
  if (!isDevChildLeaseParticipantMessage(message)) {
    throw new Error("Development harness sent an invalid lease participant.");
  }
  return message.participant;
}

function spawnObservedDevelopmentHarness(
  useWindowsSignalHarness: boolean,
): ObservedDevelopmentHarness {
  const participant = Promise.withResolvers<ReturnType<typeof requireParticipant>>();
  const bootstrap = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const shutdownAcknowledged = Promise.withResolvers<void>();
  const signalObserved = Promise.withResolvers<void>();
  const barriers = new Map<string, () => void>();
  const counts = new Map<string, number>();
  const child = spawn(
    bunExecutable,
    [
      ...(useWindowsSignalHarness
        ? [windowsSignalHarnessPath, handshakeHarnessPath]
        : [handshakeHarnessPath]),
    ],
    {
      env: {
        ...process.env,
        [writerLeaseTokenEnvironmentVariable]: randomBytes(32).toString("hex"),
      },
      shell: false,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const messageHandlers = new Map<string, (message: object) => void>([
    ["harness:bootstrap", () => bootstrap.resolve()],
    ["harness:closed", () => closed.resolve()],
    ["reforce:shutdown-ack", () => shutdownAcknowledged.resolve()],
    ["harness:signal-observed", () => signalObserved.resolve()],
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
    if (isDevChildLeaseParticipantMessage(message)) {
      participant.resolve(message.participant);
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
    bootstrap: bootstrap.promise,
    closed: closed.promise,
    shutdownAcknowledged: shutdownAcknowledged.promise,
    signalObserved: signalObserved.promise,
    messageCount: (type) => counts.get(type) ?? 0,
    async barrier() {
      const requestId = randomUUID();
      const acknowledgement = Promise.withResolvers<void>();
      barriers.set(requestId, acknowledgement.resolve);
      await send(child, { type: "harness:barrier", requestId });
      await withTimeout(acknowledgement.promise, "Development harness barrier timed out.");
    },
  };
}

function forgetSubprocess(child: ChildProcess): void {
  const index = subprocesses.findIndex((subprocess) => subprocess.child === child);
  if (index >= 0) {
    subprocesses.splice(index, 1);
  }
}

function parseObservation(output: string): Record<string, unknown> {
  const value: unknown = JSON.parse(output.trim());
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Development entry harness returned an invalid observation.");
  }
  return Object.fromEntries(Object.entries(value));
}

function requireTextOutput(output: unknown): string {
  if (typeof output !== "string") {
    throw new Error("Development entry harness did not return text output.");
  }
  return output;
}

function harnessObservation(result: {
  readonly stdout: unknown;
  readonly stderr: unknown;
}): Record<string, unknown> {
  const output = requireTextOutput(result.stdout);
  if (output.trim().length === 0) {
    throw new Error(`Development entry harness produced no output: ${String(result.stderr)}`);
  }
  return parseObservation(output);
}

test("a real Bun process closes the old Context before applying updated ESM binding", async () => {
  const result = await runCommand(bunExecutable, [harnessPath, "strict-order"], {
    timeout: 10_000,
  });
  const observation = harnessObservation(result);

  expect(result.exitCode).toBe(0);
  expect(Reflect.get(observation, "events")).toEqual([
    "accept:reforce:application-bootstrap",
    "bootstrap:1",
    "check:false",
    "close:1",
    "apply",
    "bootstrap:2",
    "close:2",
    "flush",
  ]);
  expect(Reflect.get(observation, "timersCreated")).toBe(1);
  expect(Reflect.get(observation, "timersCleared")).toBe(1);
  expect(Reflect.get(observation, "listenerDelta")).toBe(0);
});

test("a real Bun process keeps HMR fatal primary and exits nonzero after cleanup", async () => {
  const result = await runCommand(bunExecutable, [harnessPath, "fatal"], { timeout: 10_000 });
  const observation = harnessObservation(result);

  expect(result.exitCode).toBe(1);
  expect(Reflect.get(observation, "primaryError")).toBe("check fatal");
  expect(Reflect.get(observation, "errorMessages")).toEqual([
    "check fatal",
    "cleanup fatal",
    "flush fatal",
  ]);
  expect(Reflect.get(observation, "timersCreated")).toBe(1);
  expect(Reflect.get(observation, "timersCleared")).toBe(1);
  expect(Reflect.get(observation, "listenerDelta")).toBe(0);
});

test("a failed bootstrap exits after cleanup without reporting child readiness", async () => {
  const messages: unknown[] = [];
  const subprocess = spawn(bunExecutable, [bootstrapFailureHarnessPath], {
    env: {
      ...process.env,
      [writerLeaseTokenEnvironmentVariable]: "writer-harness-token",
    },
    shell: false,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  const stderrStream = subprocess.stderr;
  if (stderrStream === null) {
    throw new Error("Development runtime bootstrap harness has no stderr stream.");
  }
  stderrStream.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let acknowledgement = Promise.resolve();
  subprocess.on("message", (message: unknown) => {
    messages.push(message);
    if (!isDevChildLeaseParticipantMessage(message)) {
      return;
    }
    acknowledgement = new Promise<void>((resolve, reject) => {
      subprocess.send(
        {
          type: "reforce:lease-participant-ack",
          participantToken: message.participant.participantToken,
          ok: true,
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        },
      );
    });
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subprocess.kill();
      reject(new Error("Development runtime bootstrap harness did not exit."));
    }, 10_000);
    subprocess.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    subprocess.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  await acknowledgement;

  expect(exitCode).toBe(1);
  expect(messages.filter(isDevChildLeaseParticipantMessage)).toHaveLength(1);
  expect(messages.some(isDevChildReadyMessage)).toBe(false);
  expect(stderr).toContain("[BOOTSTRAP_FAILED]");
});

test("development queues parent IPC shutdown while the lease acknowledgement is delayed", async () => {
  const harness = spawnObservedDevelopmentHarness(false);
  const participant = await withTimeout(
    harness.participant,
    "Development harness did not publish a participant.",
  );
  const requestId = randomUUID();

  await send(harness.child, { type: "reforce:shutdown", requestId });
  await harness.barrier();
  await send(harness.child, {
    type: "reforce:lease-participant-ack",
    participantToken: participant.participantToken,
    ok: true,
  });
  await withTimeout(harness.bootstrap, "Development harness did not bootstrap.");
  await withTimeout(harness.closed, "Development harness did not close after queued IPC.");
  await withTimeout(
    harness.shutdownAcknowledged,
    "Development harness did not acknowledge queued IPC shutdown.",
  );
  expect(await withTimeout(harness.completion, "Development harness did not exit.")).toBe(0);
  forgetSubprocess(harness.child);

  expect(harness.messageCount("harness:closed")).toBe(1);
  expect(harness.messageCount("reforce:dev-ready")).toBe(0);
  expect(harness.messageCount("reforce:shutdown-ack")).toBe(1);
}, 15_000);

test("development queues a platform signal while the lease acknowledgement is delayed", async () => {
  const harness = spawnObservedDevelopmentHarness(process.platform === "win32");
  const participant = await withTimeout(
    harness.participant,
    "Development harness did not publish a participant.",
  );

  if (process.platform === "win32") {
    await send(harness.child, { type: "reforce:e2e-signal", signal: "SIGINT" });
  } else if (!harness.child.kill("SIGINT")) {
    throw new Error("Unable to deliver SIGINT to the development harness.");
  }
  await withTimeout(harness.signalObserved, "Development harness did not observe SIGINT.");
  await send(harness.child, {
    type: "reforce:lease-participant-ack",
    participantToken: participant.participantToken,
    ok: true,
  });
  await withTimeout(harness.bootstrap, "Development harness did not bootstrap.");
  await withTimeout(harness.closed, "Development harness did not close after queued SIGINT.");
  expect(await withTimeout(harness.completion, "Development harness did not exit.")).toBe(0);
  forgetSubprocess(harness.child);

  expect(harness.messageCount("harness:closed")).toBe(1);
  expect(harness.messageCount("harness:signal-observed")).toBe(1);
  expect(harness.messageCount("reforce:dev-ready")).toBe(0);
}, 15_000);
