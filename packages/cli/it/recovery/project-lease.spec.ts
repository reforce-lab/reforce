import { afterEach, describe, expect, test } from "bun:test";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import type { LeaseParticipant } from "@/lease-endpoint";
import { ProjectBusyError, ProjectLease } from "@/project-lease";
import { spawnBunIpcHarness } from "../support/process/bun-ipc-harness";

const leases: ProjectLease[] = [];
const projects: TemporaryProject[] = [];

afterEach(async () => {
  for (const lease of leases.splice(0).reverse()) {
    await lease.release();
  }
  for (const project of projects.splice(0).reverse()) {
    await project.cleanup();
  }
});

async function temporaryProject(): Promise<TemporaryProject> {
  const project = await createTemporaryProject();
  projects.push(project);
  return project;
}

async function spawnLeaseHolder(projectRoot: string, mode: "reader" | "writer") {
  const harnessPath = fileURLToPath(
    new URL("../support/process/lease/project-lease.harness.ts", import.meta.url),
  );
  const subprocess = spawnBunIpcHarness(harnessPath, [projectRoot, mode]);
  let message: unknown;
  try {
    message = await subprocess.waitForMessage("Lease holder did not publish readiness.");
  } catch (error) {
    subprocess.child.kill();
    await subprocess.wait();
    throw error;
  }
  const leaseToken =
    typeof message === "object" &&
    message !== null &&
    Reflect.get(message, "type") === "ready" &&
    typeof Reflect.get(message, "leaseToken") === "string"
      ? Reflect.get(message, "leaseToken")
      : undefined;
  if (leaseToken === undefined) {
    subprocess.child.kill();
    const result = await subprocess.wait();
    throw new Error(
      `Lease holder sent an invalid ready message and exited with code ${result.exitCode ?? "null"}.`,
    );
  }
  return { process: subprocess, leaseToken };
}

function parseParticipant(message: unknown): LeaseParticipant | undefined {
  if (
    typeof message !== "object" ||
    message === null ||
    Reflect.get(message, "type") !== "participant"
  ) {
    return undefined;
  }
  const participant = Reflect.get(message, "participant");
  if (typeof participant !== "object" || participant === null) {
    return undefined;
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
    !Number.isInteger(port) ||
    typeof challenge !== "string" ||
    role !== "child"
  ) {
    return undefined;
  }
  return { participantToken, host, port, challenge, role };
}

describe("project lease", () => {
  test("allows multiple readers for one project", async () => {
    const project = await temporaryProject();
    const first = await ProjectLease.acquire({ projectRoot: project.projectRoot, mode: "reader" });
    const second = await ProjectLease.acquire({ projectRoot: project.projectRoot, mode: "reader" });
    leases.push(first, second);

    expect(first.leaseToken).not.toBe(second.leaseToken);
  });

  test("shares readers across real processes while excluding a writer", async () => {
    const project = await temporaryProject();
    const holder = await spawnLeaseHolder(project.projectRoot, "reader");
    const localReader = await ProjectLease.acquire({
      projectRoot: project.projectRoot,
      mode: "reader",
    });
    leases.push(localReader);

    await expect(
      ProjectLease.acquire({ projectRoot: project.projectRoot, mode: "writer" }),
    ).rejects.toBeInstanceOf(ProjectBusyError);

    await holder.process.sendMessage({ type: "release" });
    expect((await holder.process.wait()).exitCode).toBe(0);
  });

  test("rejects a writer while a reader is live", async () => {
    const project = await temporaryProject();
    const reader = await ProjectLease.acquire({ projectRoot: project.projectRoot, mode: "reader" });
    leases.push(reader);

    const acquisition = ProjectLease.acquire({ projectRoot: project.projectRoot, mode: "writer" });

    await expect(acquisition).rejects.toBeInstanceOf(ProjectBusyError);
  });

  test("rejects a reader while a writer is live", async () => {
    const project = await temporaryProject();
    const writer = await ProjectLease.acquire({ projectRoot: project.projectRoot, mode: "writer" });
    leases.push(writer);

    const acquisition = ProjectLease.acquire({ projectRoot: project.projectRoot, mode: "reader" });

    await expect(acquisition).rejects.toBeInstanceOf(ProjectBusyError);
  });

  test("does not block a different project", async () => {
    const firstProject = await temporaryProject();
    const secondProject = await temporaryProject();
    const first = await ProjectLease.acquire({
      projectRoot: firstProject.projectRoot,
      mode: "writer",
    });
    const second = await ProjectLease.acquire({
      projectRoot: secondProject.projectRoot,
      mode: "writer",
    });
    leases.push(first, second);

    expect(first.projectRoot).not.toBe(second.projectRoot);
  });

  test("rejects a lease namespace that resolves outside the project", async () => {
    const project = await temporaryProject();
    const external = await temporaryProject();
    await symlink(
      external.projectRoot,
      join(project.projectRoot, ".reforce"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const acquisition = ProjectLease.acquire({
      projectRoot: project.projectRoot,
      mode: "writer",
    });

    await expect(acquisition).rejects.toThrow("outside its required boundary");
  });

  test("shares one token-checked release operation", async () => {
    const project = await temporaryProject();
    const lease = await ProjectLease.acquire({ projectRoot: project.projectRoot, mode: "writer" });

    const first = lease.release();
    const second = lease.release();

    expect(first).toBe(second);
    await first;
  });

  test("does not treat a matching or reused PID as ownership proof", async () => {
    const project = await temporaryProject();
    const holder = await spawnLeaseHolder(project.projectRoot, "writer");
    const recordPath = join(project.projectRoot, ".reforce", "lease", "writer", "record.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    await writeFile(recordPath, `${JSON.stringify({ ...record, pid: process.pid })}\n`);

    await expect(
      ProjectLease.acquire({ projectRoot: project.projectRoot, mode: "writer" }),
    ).rejects.toBeInstanceOf(ProjectBusyError);

    await holder.process.sendMessage({ type: "release" });
    expect((await holder.process.wait()).exitCode).toBe(0);
  });

  test("a stale release cannot remove a replacement owner record", async () => {
    const project = await temporaryProject();
    const lease = await ProjectLease.acquire({
      projectRoot: project.projectRoot,
      mode: "writer",
    });
    const recordPath = join(project.projectRoot, ".reforce", "lease", "writer", "record.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    await writeFile(
      recordPath,
      `${JSON.stringify({ ...record, leaseToken: "replacement-owner" })}\n`,
    );

    await lease.release();

    expect(await readFile(recordPath, "utf8")).toContain("replacement-owner");
  });

  test("recovers a writer only after its real process endpoint disappears", async () => {
    const project = await temporaryProject();
    const holder = await spawnLeaseHolder(project.projectRoot, "writer");
    await holder.process.sendMessage({ type: "crash" });
    expect((await holder.process.wait()).exitCode).toBe(86);

    const replacement = await ProjectLease.acquire({
      projectRoot: project.projectRoot,
      mode: "writer",
    });
    leases.push(replacement);

    expect(replacement.recoveredWriterTokens).toEqual([holder.leaseToken]);
  });

  test("keeps stale writer proof available when a reader cannot recover transactions", async () => {
    const project = await temporaryProject();
    const holder = await spawnLeaseHolder(project.projectRoot, "writer");
    await holder.process.sendMessage({ type: "crash" });
    expect((await holder.process.wait()).exitCode).toBe(86);

    await expect(
      ProjectLease.acquire({ projectRoot: project.projectRoot, mode: "reader" }),
    ).rejects.toBeInstanceOf(ProjectBusyError);
    const replacement = await ProjectLease.acquire({
      projectRoot: project.projectRoot,
      mode: "writer",
    });
    leases.push(replacement);

    expect(replacement.recoveredWriterTokens).toEqual([holder.leaseToken]);
  });

  test("keeps a lease live while a registered child endpoint is still closing", async () => {
    const project = await temporaryProject();
    const holder = await spawnLeaseHolder(project.projectRoot, "writer");
    const participantHarnessPath = fileURLToPath(
      new URL("../support/process/lease/project-lease-participant.harness.ts", import.meta.url),
    );
    const participantProcess = spawnBunIpcHarness(participantHarnessPath, [holder.leaseToken]);
    let participantClosed = false;
    let holderClosed = false;
    try {
      const participant = parseParticipant(
        await participantProcess.waitForMessage("Lease participant did not publish readiness."),
      );
      if (participant === undefined) {
        throw new Error("Lease participant sent an invalid endpoint record.");
      }
      await holder.process.sendMessage({ type: "add-participant", participant });
      await holder.process.waitForMessage("Lease holder did not register its participant.");
      await holder.process.sendMessage({ type: "parent-crash" });
      const holderResult = await holder.process.wait();
      holderClosed = true;
      expect(holderResult.exitCode).toBe(88);
      await participantProcess.sendMessage({ type: "begin-close" });
      await participantProcess.waitForMessage("Lease participant did not enter closing.");

      await expect(
        ProjectLease.acquire({ projectRoot: project.projectRoot, mode: "writer" }),
      ).rejects.toBeInstanceOf(ProjectBusyError);

      await participantProcess.sendMessage({ type: "finish-close" });
      expect((await participantProcess.wait()).exitCode).toBe(0);
      participantClosed = true;
      const replacement = await ProjectLease.acquire({
        projectRoot: project.projectRoot,
        mode: "writer",
      });
      leases.push(replacement);
      expect(replacement.recoveredWriterTokens).toEqual([holder.leaseToken]);
    } finally {
      if (!participantClosed) {
        participantProcess.child.kill();
        await participantProcess.wait();
      }
      if (!holderClosed) {
        holder.process.child.kill();
        await holder.process.wait();
      }
    }
  });
});
