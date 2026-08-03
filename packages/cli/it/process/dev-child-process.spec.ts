import { afterEach, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTemporaryProject,
  resolveBunExecutable,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { spawnDevChild } from "@/dev/child-process";
import { type LeaseParticipant, probeLeaseEndpoint } from "@/project/lease-endpoint";

const harnessPath = fileURLToPath(
  new URL("../support/process/dev/dev-child-shutdown.harness.ts", import.meta.url),
);
const startupFailureHarnessPath = fileURLToPath(
  new URL("../support/process/dev/dev-child-startup-failure.harness.ts", import.meta.url),
);
const silentShutdownHarnessPath = fileURLToPath(
  new URL("../support/process/dev/dev-child-silent-shutdown.harness.ts", import.meta.url),
);
const bunExecutable = await resolveBunExecutable();
const projects: TemporaryProject[] = [];

afterEach(async () => {
  for (const project of projects.splice(0).reverse()) {
    await project.cleanup();
  }
});

interface FailureObservation {
  readonly leaseToken: string;
  readonly participant: LeaseParticipant;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${path}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function readFailureObservation(path: string): Promise<FailureObservation> {
  await waitForFile(path);
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid development child failure observation.");
  }
  const leaseToken = Reflect.get(value, "leaseToken");
  const participant = Reflect.get(value, "participant");
  if (typeof leaseToken !== "string" || typeof participant !== "object" || participant === null) {
    throw new Error("Incomplete development child failure observation.");
  }
  const participantToken = Reflect.get(participant, "participantToken");
  const host = Reflect.get(participant, "host");
  const port = Reflect.get(participant, "port");
  const challenge = Reflect.get(participant, "challenge");
  const role = Reflect.get(participant, "role");
  if (
    typeof participantToken !== "string" ||
    host !== "127.0.0.1" ||
    typeof port !== "number" ||
    typeof challenge !== "string" ||
    role !== "child"
  ) {
    throw new Error("Invalid development child failure participant.");
  }
  return {
    leaseToken,
    participant: { participantToken, host, port, challenge, role },
  };
}

async function expectEndpointDead(path: string): Promise<void> {
  const observation = await readFailureObservation(path);
  expect(await probeLeaseEndpoint(observation.participant, observation.leaseToken, 500)).toBe(
    "dead",
  );
}

test("Windows-style child shutdown uses IPC acknowledgement", async () => {
  const child = await spawnDevChild({
    entryPath: harnessPath,
    cwd: process.cwd(),
    bunExecutable,
    platform: "win32",
    waitForReady: true,
  });

  await child.requestShutdown("SIGTERM");
  const exit = await child.exited;

  expect(exit.exitCode).toBe(0);
});

test("a clean child exit outranks a missing shutdown acknowledgement", async () => {
  const child = await spawnDevChild({
    entryPath: silentShutdownHarnessPath,
    cwd: process.cwd(),
    bunExecutable,
    platform: "win32",
    waitForReady: true,
  });

  const shutdown = child.requestShutdown("SIGTERM");

  await expect(shutdown).resolves.toBeUndefined();
});

test.skipIf(process.platform === "win32")(
  "POSIX child shutdown forwards the requested signal",
  async () => {
    const child = await spawnDevChild({
      entryPath: harnessPath,
      cwd: process.cwd(),
      bunExecutable,
      waitForReady: true,
    });

    await child.requestShutdown("SIGINT");
    const exit = await child.exited;

    expect(exit.exitCode).toBe(0);
  },
);

test("a participant handshake timeout terminates the real child and closes its endpoint", async () => {
  const project = await createTemporaryProject();
  projects.push(project);
  const observationPath = join(project.projectRoot, "participant-timeout.json");

  const failure = spawnDevChild({
    entryPath: startupFailureHarnessPath,
    cwd: project.projectRoot,
    bunExecutable,
    applicationArguments: ["silent", observationPath],
    ipcTimeoutMilliseconds: 1_000,
    leaseParticipant: {
      async add() {},
      async remove() {},
    },
  });

  await expect(failure).rejects.toThrow("did not publish its lease participant");
  await expectEndpointDead(observationPath);
});

test("a readiness timeout terminates the child before removing its participant", async () => {
  const project = await createTemporaryProject();
  projects.push(project);
  const observationPath = join(project.projectRoot, "readiness-timeout.json");
  let removedParticipantToken: string | undefined;
  let endpointStateDuringRemove: string | undefined;

  const failure = spawnDevChild({
    entryPath: startupFailureHarnessPath,
    cwd: project.projectRoot,
    bunExecutable,
    applicationArguments: ["participant", observationPath],
    ipcTimeoutMilliseconds: 1_000,
    waitForReady: true,
    leaseParticipant: {
      async add() {},
      async remove(participantToken) {
        const observation = await readFailureObservation(observationPath);
        removedParticipantToken = participantToken;
        endpointStateDuringRemove = await probeLeaseEndpoint(
          observation.participant,
          observation.leaseToken,
          500,
        );
      },
    },
  });

  await expect(failure).rejects.toThrow("did not report readiness");
  const observation = await readFailureObservation(observationPath);
  expect(removedParticipantToken).toBe(observation.participant.participantToken);
  expect(endpointStateDuringRemove).toBe("dead");
});

test("a participant cleanup error is appended without replacing the readiness failure", async () => {
  const project = await createTemporaryProject();
  projects.push(project);
  const observationPath = join(project.projectRoot, "cleanup-failure.json");

  const failure = spawnDevChild({
    entryPath: startupFailureHarnessPath,
    cwd: project.projectRoot,
    bunExecutable,
    applicationArguments: ["participant", observationPath],
    ipcTimeoutMilliseconds: 1_000,
    waitForReady: true,
    leaseParticipant: {
      async add() {},
      async remove() {
        throw new Error("participant cleanup failed");
      },
    },
  });

  try {
    await failure;
    throw new Error("Expected development child startup to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) {
      throw error;
    }
    const primaryError = error.cause;
    expect(primaryError).toBeInstanceOf(Error);
    if (!(primaryError instanceof Error)) {
      throw error;
    }
    expect(primaryError.message).toContain("did not report readiness");
    expect(
      error.errors.map((item) => (item instanceof Error ? item.message : String(item))),
    ).toEqual(["Development child did not report readiness.", "participant cleanup failed"]);
  }
});
