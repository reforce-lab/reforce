import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveNodeExecutable, runCommand } from "@reforce/tooling-testing";
import {
  isDevChildLeaseParticipantMessage,
  isDevChildReadyMessage,
  writerLeaseTokenEnvironmentVariable,
} from "#internal/dev-ipc";

const fixturePath = fileURLToPath(
  new URL("../../fixtures/process/dev/dev-entry.fixture.ts", import.meta.url),
);
const bootstrapFailureFixturePath = fileURLToPath(
  new URL("../../fixtures/process/dev/dev-runtime-bootstrap.fixture.ts", import.meta.url),
);
const handshakeFixturePath = fileURLToPath(
  new URL("../../fixtures/process/dev/dev-runtime-handshake.fixture.ts", import.meta.url),
);
const windowsSignalFixturePath = fileURLToPath(
  new URL("../../fixtures/process/windows-signal.fixture.ts", import.meta.url),
);
const nodeExecutable = await resolveNodeExecutable();
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
    throw new Error("Development fixture has no IPC channel.");
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

interface ObservedDevelopmentFixture {
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
    throw new Error("Development fixture sent an invalid lease participant.");
  }
  return message.participant;
}

function spawnObservedDevelopmentFixture(
  useWindowsSignalHarness: boolean,
): ObservedDevelopmentFixture {
  const participant = Promise.withResolvers<ReturnType<typeof requireParticipant>>();
  const bootstrap = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const shutdownAcknowledged = Promise.withResolvers<void>();
  const signalObserved = Promise.withResolvers<void>();
  const barriers = new Map<string, () => void>();
  const counts = new Map<string, number>();
  const child = spawn(
    nodeExecutable,
    [
      "--conditions=development",
      ...(useWindowsSignalHarness
        ? [windowsSignalFixturePath, handshakeFixturePath]
        : [handshakeFixturePath]),
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
    ["fixture:bootstrap", () => bootstrap.resolve()],
    ["fixture:closed", () => closed.resolve()],
    ["reforce:shutdown-ack", () => shutdownAcknowledged.resolve()],
    ["fixture:signal-observed", () => signalObserved.resolve()],
    [
      "fixture:barrier-ack",
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
      await send(child, { type: "fixture:barrier", requestId });
      await withTimeout(acknowledgement.promise, "Development fixture barrier timed out.");
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
    throw new Error("Development entry fixture returned an invalid observation.");
  }
  return Object.fromEntries(Object.entries(value));
}

function requireTextOutput(output: unknown): string {
  if (typeof output !== "string") {
    throw new Error("Development entry fixture did not return text output.");
  }
  return output;
}

function fixtureObservation(result: {
  readonly stdout: unknown;
  readonly stderr: unknown;
}): Record<string, unknown> {
  const output = requireTextOutput(result.stdout);
  if (output.trim().length === 0) {
    throw new Error(`Development entry fixture produced no output: ${String(result.stderr)}`);
  }
  return parseObservation(output);
}

test("a real Node process closes the old Context before applying updated ESM binding", async () => {
  const result = await runCommand(
    nodeExecutable,
    ["--conditions=development", fixturePath, "strict-order"],
    { timeout: 10_000 },
  );
  const observation = fixtureObservation(result);

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

test("a real Node process keeps HMR fatal primary and exits nonzero after cleanup", async () => {
  const result = await runCommand(
    nodeExecutable,
    ["--conditions=development", fixturePath, "fatal"],
    { timeout: 10_000 },
  );
  const observation = fixtureObservation(result);

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
  const subprocess = spawn(
    nodeExecutable,
    ["--conditions=development", bootstrapFailureFixturePath],
    {
      env: {
        ...process.env,
        [writerLeaseTokenEnvironmentVariable]: "writer-fixture-token",
      },
      shell: false,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  const stderrStream = subprocess.stderr;
  if (stderrStream === null) {
    throw new Error("Development runtime bootstrap fixture has no stderr stream.");
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
      reject(new Error("Development runtime bootstrap fixture did not exit."));
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
  const fixture = spawnObservedDevelopmentFixture(false);
  const participant = await withTimeout(
    fixture.participant,
    "Development fixture did not publish a participant.",
  );
  const requestId = randomUUID();

  await send(fixture.child, { type: "reforce:shutdown", requestId });
  await fixture.barrier();
  await send(fixture.child, {
    type: "reforce:lease-participant-ack",
    participantToken: participant.participantToken,
    ok: true,
  });
  await withTimeout(fixture.bootstrap, "Development fixture did not bootstrap.");
  await withTimeout(fixture.closed, "Development fixture did not close after queued IPC.");
  await withTimeout(
    fixture.shutdownAcknowledged,
    "Development fixture did not acknowledge queued IPC shutdown.",
  );
  expect(await withTimeout(fixture.completion, "Development fixture did not exit.")).toBe(0);
  forgetSubprocess(fixture.child);

  expect(fixture.messageCount("fixture:closed")).toBe(1);
  expect(fixture.messageCount("reforce:dev-ready")).toBe(0);
  expect(fixture.messageCount("reforce:shutdown-ack")).toBe(1);
}, 15_000);

test("development queues a platform signal while the lease acknowledgement is delayed", async () => {
  const fixture = spawnObservedDevelopmentFixture(process.platform === "win32");
  const participant = await withTimeout(
    fixture.participant,
    "Development fixture did not publish a participant.",
  );

  if (process.platform === "win32") {
    await send(fixture.child, { type: "reforce:e2e-signal", signal: "SIGINT" });
  } else if (!fixture.child.kill("SIGINT")) {
    throw new Error("Unable to deliver SIGINT to the development fixture.");
  }
  await withTimeout(fixture.signalObserved, "Development fixture did not observe SIGINT.");
  await send(fixture.child, {
    type: "reforce:lease-participant-ack",
    participantToken: participant.participantToken,
    ok: true,
  });
  await withTimeout(fixture.bootstrap, "Development fixture did not bootstrap.");
  await withTimeout(fixture.closed, "Development fixture did not close after queued SIGINT.");
  expect(await withTimeout(fixture.completion, "Development fixture did not exit.")).toBe(0);
  forgetSubprocess(fixture.child);

  expect(fixture.messageCount("fixture:closed")).toBe(1);
  expect(fixture.messageCount("fixture:signal-observed")).toBe(1);
  expect(fixture.messageCount("reforce:dev-ready")).toBe(0);
}, 15_000);
