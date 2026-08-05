import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createChildLeaseParticipant,
  type LeaseParticipant,
} from "@reforce/runtime/lease-endpoint";
import {
  bundleHarness,
  createTemporaryProject,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterEach, describe, expect, test } from "vitest";
import { ProjectBusyError, ProjectLease } from "@/project/lease";
import { spawnNodeIpcHarness } from "../support/process/node-ipc-harness";

interface FakeGateEndpoint {
  readonly port: number;
  close(): Promise<void>;
}

const leases: ProjectLease[] = [];
const projects: TemporaryProject[] = [];
const endpoints: FakeGateEndpoint[] = [];

afterEach(async () => {
  for (const lease of leases.splice(0).reverse()) {
    await lease.release();
  }
  for (const endpoint of endpoints.splice(0).reverse()) {
    await endpoint.close();
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

// 抢锁 gate 的存活探测走 TCP，用真服务端才能控制探测结果（"dead" / "unknown"）以及探测窗口内的
// 记录变更时序；`inspectExistingGate` 是模块私有的，没有可注入的缝。
async function fakeGateEndpoint(
  handleProbe: (socket: Socket) => Promise<void> | void,
): Promise<FakeGateEndpoint> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    void Promise.resolve(handleProbe(socket)).catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Fake gate endpoint did not publish a TCP port.");
  }
  const endpoint: FakeGateEndpoint = {
    port: address.port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  endpoints.push(endpoint);
  return endpoint;
}

function gateRecordJson(port: number, gateToken: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    gateToken,
    host: "127.0.0.1",
    port,
    challenge: "gate-challenge",
  })}\n`;
}

async function prepareGateRoot(projectRoot: string): Promise<string> {
  const gateRoot = join(projectRoot, ".reforce", "lease", "gate");
  await mkdir(gateRoot, { recursive: true });
  return gateRoot;
}

async function replaceGateRecord(gateRoot: string, contents: string): Promise<void> {
  const staging = join(gateRoot, "record.replacement.json");
  await writeFile(staging, contents);
  await rename(staging, join(gateRoot, "record.json"));
}

async function spawnLeaseHolder(projectRoot: string, mode: "reader" | "writer") {
  const harnessPath = await bundleHarness(
    fileURLToPath(new URL("../support/process/lease/project-lease.harness.ts", import.meta.url)),
  );
  const subprocess = spawnNodeIpcHarness(harnessPath, [projectRoot, mode]);
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

  // The containment check in this file is deliberately strict: `.reforce` resolving to the
  // project root itself must stay a rejection, because the same check gates
  // safeRemoveDirectory's `rm(recursive)`. Relaxing it to "contained or equal" would let the
  // collapsed layout through here and hand lease cleanup a target equal to its own boundary,
  // i.e. recursive deletion of the user's project root (#55).
  test("rejects a lease namespace that resolves to the project root itself", async () => {
    const project = await temporaryProject();
    await symlink(
      project.projectRoot,
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

  test("ignores a stray non-directory entry under readers/", async () => {
    const project = await temporaryProject();
    const readersRoot = join(project.projectRoot, ".reforce", "lease", "readers");
    await mkdir(readersRoot, { recursive: true });
    await writeFile(join(readersRoot, ".DS_Store"), "finder\n");

    const lease = await ProjectLease.acquire({
      projectRoot: project.projectRoot,
      mode: "writer",
    });
    leases.push(lease);

    expect(lease.mode).toBe("writer");
  });

  test("retries a release that failed while a child participant was still live", async () => {
    const project = await temporaryProject();
    const lease = await ProjectLease.acquire({ projectRoot: project.projectRoot, mode: "writer" });
    const child = await createChildLeaseParticipant(lease.leaseToken);
    await lease.addParticipant(child.participant);
    await expect(lease.release()).rejects.toBeInstanceOf(ProjectBusyError);
    await child.close();

    await lease.release();

    expect(
      existsSync(join(project.projectRoot, ".reforce", "lease", "writer", "record.json")),
    ).toBe(false);
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

  test("rejects an acquisition when the gate record carries an out-of-range port", async () => {
    const project = await temporaryProject();
    const gateRoot = join(project.projectRoot, ".reforce", "lease", "gate");
    await mkdir(gateRoot, { recursive: true });
    await writeFile(
      join(gateRoot, "record.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        gateToken: "corrupt-gate-token",
        host: "127.0.0.1",
        port: 70_000,
        challenge: "corrupt-gate-challenge",
      })}\n`,
    );

    const acquisition = ProjectLease.acquire({ projectRoot: project.projectRoot, mode: "writer" });

    await expect(acquisition).rejects.toBeInstanceOf(ProjectBusyError);
  });

  test("retries the acquisition gate when the gate directory is released while waiting", async () => {
    const project = await temporaryProject();
    const gateRoot = await prepareGateRoot(project.projectRoot);
    // 目录非空，发布用的 rename 才会撞上 ENOTEMPTY 判定为竞争失败；空目录在 POSIX 上会被直接覆盖。
    // 没有 record.json 则与「持有者刚刚释放 gate」产生的中间状态逐字节一致（#101）。
    await writeFile(join(gateRoot, "holder.marker"), "holder\n");
    const release = setTimeout(() => {
      void rm(gateRoot, { recursive: true, force: true }).catch(() => {});
    }, 200);
    release.unref();

    const lease = await ProjectLease.acquire({
      projectRoot: project.projectRoot,
      mode: "writer",
      gateWaitMilliseconds: 5_000,
    });
    leases.push(lease);

    expect(lease.leaseToken.length).toBeGreaterThan(0);
  });

  test("retries the acquisition gate while the gate probe has no verdict", async () => {
    const project = await temporaryProject();
    const gateRoot = await prepareGateRoot(project.projectRoot);
    const probed = Promise.withResolvers<void>();
    // 关停中的持有者会 destroy 未完成的探测连接，等待方拿到的结果是 "unknown"；「连上就 FIN、不回数据」
    // 复现同一个结果又不依赖 RST 的到达时序。
    const endpoint = await fakeGateEndpoint((socket) => {
      socket.end();
      probed.resolve();
    });
    await writeFile(
      join(gateRoot, "record.json"),
      gateRecordJson(endpoint.port, "unknown-gate-token"),
    );

    const acquisition = ProjectLease.acquire({
      projectRoot: project.projectRoot,
      mode: "writer",
      gateWaitMilliseconds: 5_000,
    });
    await probed.promise;
    await endpoint.close();
    const lease = await acquisition;
    leases.push(lease);

    expect(lease.leaseToken.length).toBeGreaterThan(0);
  });

  test("spends the gate budget when the gate record changes during the probe", async () => {
    const project = await temporaryProject();
    const gateRoot = await prepareGateRoot(project.projectRoot);
    let probes = 0;
    let gatePort = 0;
    const endpoint = await fakeGateEndpoint(async (socket) => {
      probes += 1;
      // 只换一次记录：缺陷版本要等到「记录不再变」才会退出重试循环，用例才能快速判失败而不是挂死。
      if (probes === 1) {
        await replaceGateRecord(gateRoot, gateRecordJson(gatePort, "replaced-gate-token"));
      }
      socket.end(
        `${JSON.stringify({ schemaVersion: 1, leaseToken: "other", challenge: "other" })}\n`,
      );
    });
    gatePort = endpoint.port;
    await writeFile(join(gateRoot, "record.json"), gateRecordJson(gatePort, "initial-gate-token"));

    const acquisition = ProjectLease.acquire({
      projectRoot: project.projectRoot,
      mode: "writer",
      gateWaitMilliseconds: 0,
    });

    await expect(acquisition).rejects.toBeInstanceOf(ProjectBusyError);
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
    const participantProcess = spawnNodeIpcHarness(participantHarnessPath, [holder.leaseToken]);
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
