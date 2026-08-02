import { afterEach, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { createChildLeaseParticipant } from "#internal/project-lease";
import type { CliReporterEvent, Reporter } from "#internal/reporter";
import { runStartCommand } from "#internal/start-command";

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

function recordingReporter(onFlush?: () => void): {
  readonly events: CliReporterEvent[];
  readonly flushCount: number;
  readonly reporter: Reporter;
} {
  const events: CliReporterEvent[] = [];
  let flushCount = 0;
  return {
    events,
    get flushCount() {
      return flushCount;
    },
    reporter: {
      report(event) {
        events.push(event);
      },
      async flush() {
        onFlush?.();
        flushCount += 1;
      },
    },
  };
}

test("start rejects an artifact while dist transaction metadata remains", async () => {
  const project = await createTemporaryProject({
    ".reforce": { transactions: { dist: { "stale-token": { "journal.json": "{}\n" } } } },
    dist: { "main.mjs": "export {};\n" },
  });
  projects.push(project);
  const output = recordingReporter();

  const exitCode = await runStartCommand({
    cwd: project.projectRoot,
    projectDirectory: ".",
    reporter: output.reporter,
  });

  expect(exitCode).toBe(1);
  expect(output.events).toHaveLength(1);
  expect(output.events[0]).toMatchObject({ kind: "failure", code: "ARTIFACT_INVALID" });
});

test("start rejects transaction output even when its token has an invalid shape", async () => {
  const project = await createTemporaryProject({
    "dist.backup-invalid.token": {},
    dist: { "main.mjs": "export {};\n" },
  });
  projects.push(project);
  const output = recordingReporter();

  const exitCode = await runStartCommand({
    cwd: project.projectRoot,
    projectDirectory: ".",
    reporter: output.reporter,
  });

  expect(exitCode).toBe(1);
  expect(output.events).toHaveLength(1);
  expect(output.events[0]).toMatchObject({ kind: "failure", code: "ARTIFACT_INVALID" });
});

test("start rejects symbolic links anywhere in the production artifact", async () => {
  const project = await createTemporaryProject({
    dist: {
      chunks: { "target.mjs": "export {};\n" },
      "main.mjs": "export {};\n",
    },
  });
  projects.push(project);
  await symlink(
    join(project.projectRoot, "dist", "chunks"),
    join(project.projectRoot, "dist", "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const output = recordingReporter();

  const exitCode = await runStartCommand({
    cwd: project.projectRoot,
    projectDirectory: ".",
    reporter: output.reporter,
  });

  expect(exitCode).toBe(1);
  expect(output.events).toHaveLength(1);
  expect(output.events[0]).toMatchObject({ kind: "failure", code: "ARTIFACT_INVALID" });
});

test("start reports a lease release failure after the original artifact failure", async () => {
  const project = await createTemporaryProject({});
  projects.push(project);
  const output = recordingReporter();
  const releaseError = new Error("release failed");

  const exitCode = await runStartCommand(
    {
      cwd: project.projectRoot,
      projectDirectory: ".",
      reporter: output.reporter,
    },
    {
      async releaseLease(lease) {
        await lease.release();
        throw releaseError;
      },
    },
  );

  expect(exitCode).toBe(1);
  expect(output.events).toHaveLength(2);
  expect(output.flushCount).toBe(2);
  expect(output.events[0]).toMatchObject({ code: "ARTIFACT_INVALID" });
  expect(output.events[1]).toMatchObject({
    kind: "failure",
    command: "start",
    phase: "shutdown",
    code: "SHUTDOWN_FAILED",
  });
  const primaryEvent = output.events[0];
  if (primaryEvent?.kind !== "failure") {
    throw new Error("Expected the artifact failure event first.");
  }
  expect(output.events[1]).toHaveProperty("cause.errors", [primaryEvent.cause, releaseError]);
});

test("start reports participant removal failure after the child exits", async () => {
  const project = await createTemporaryProject({
    dist: { "main.mjs": "export {};\n" },
  });
  projects.push(project);
  const cleanupOrder: string[] = [];
  const output = recordingReporter(() => cleanupOrder.push("flush"));
  const removeError = new Error("remove participant failed");

  const exitCode = await runStartCommand(
    {
      cwd: project.projectRoot,
      projectDirectory: ".",
      reporter: output.reporter,
    },
    {
      spawnChild(input) {
        const endpoint = createChildLeaseParticipant(input.leaseToken);
        const completion = Promise.withResolvers<{ readonly exitCode: number }>();
        return {
          async getOneMessage() {
            const child = await endpoint;
            return { type: "reforce:lease-participant", participant: child.participant };
          },
          async sendMessage() {
            const child = await endpoint;
            await child.close();
            completion.resolve({ exitCode: 0 });
          },
          kill() {
            completion.resolve({ exitCode: 1 });
          },
          wait: () => completion.promise,
        };
      },
      releaseLease(lease) {
        cleanupOrder.push("release");
        return lease.release();
      },
      async removeParticipant(lease, participantToken) {
        cleanupOrder.push("remove-participant");
        await lease.removeParticipant(participantToken);
        throw removeError;
      },
    },
  );

  expect(exitCode).toBe(1);
  expect(output.events[0]).toMatchObject({ kind: "success", command: "start" });
  expect(output.events).toHaveLength(2);
  expect(output.flushCount).toBe(2);
  expect(output.events[1]).toMatchObject({
    kind: "failure",
    command: "start",
    phase: "shutdown",
    code: "SHUTDOWN_FAILED",
    cause: removeError,
  });
  expect(cleanupOrder).toEqual(["flush", "remove-participant", "release", "flush"]);
});
