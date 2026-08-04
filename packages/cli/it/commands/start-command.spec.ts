import { afterEach, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import {
  createTemporaryProject,
  createTimeoutGuard,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { runStartCommand } from "@/commands/start";
import { createChildLeaseParticipant } from "@/project/lease-endpoint";
import { recordingReporter } from "../support/recording-reporter";

// 内层判死时钟（Issue #94）：失聪窗口的回归以「哨兵先到」的形式失败，而不是把整个套件挂死在
// bun test 的 300s 外层预算上。
const withTimeout = createTimeoutGuard(2_000);

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

// 三个用例只在「坏掉的产物长什么样」上不同，start 的调用方式和 reporter 装配完全一样。
async function startOn(project: TemporaryProject) {
  const output = recordingReporter();
  const exitCode = await runStartCommand({
    cwd: project.projectRoot,
    projectDirectory: ".",
    reporter: output.reporter,
  });
  return { exitCode, output };
}

test("start rejects an artifact while dist transaction metadata remains", async () => {
  const project = await createTemporaryProject({
    ".reforce": { transactions: { dist: { "stale-token": { "journal.json": "{}\n" } } } },
    dist: { "main.mjs": "export {};\n" },
  });
  projects.push(project);
  const { exitCode, output } = await startOn(project);

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
  const { exitCode, output } = await startOn(project);

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
  const { exitCode, output } = await startOn(project);

  expect(exitCode).toBe(1);
  expect(output.events).toHaveLength(1);
  expect(output.events[0]).toMatchObject({ kind: "failure", code: "ARTIFACT_INVALID" });
});

test("start rejects a production artifact whose dist root is a symbolic link", async () => {
  const project = await createTemporaryProject({
    "dist-target": { "main.mjs": "export {};\n" },
  });
  projects.push(project);
  await symlink(
    join(project.projectRoot, "dist-target"),
    join(project.projectRoot, "dist"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const { exitCode, output } = await startOn(project);

  expect(exitCode).toBe(1);
  expect(output.events[0]).toMatchObject({
    kind: "failure",
    code: "ARTIFACT_INVALID",
    message: expect.stringContaining("symbolic link"),
  });
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
          async requestShutdown() {
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

test("a termination signal during the handshake stops the command without waiting out the handshake budget", async () => {
  const project = await createTemporaryProject({ dist: { "main.mjs": "export {};\n" } });
  projects.push(project);
  const output = recordingReporter();
  const childCalls: string[] = [];
  const spawned = Promise.withResolvers<void>();

  const command = runStartCommand(
    {
      cwd: project.projectRoot,
      projectDirectory: ".",
      reporter: output.reporter,
    },
    {
      spawnChild() {
        const completion = Promise.withResolvers<{ readonly exitCode: number }>();
        spawned.resolve();
        return {
          // 失聪窗口的触发条件：子进程活着，但迟迟不发 participant 记录（Issue #103）。
          getOneMessage: () => new Promise<never>(() => undefined),
          async sendMessage() {},
          async requestShutdown(signal) {
            childCalls.push(`shutdown:${signal}`);
          },
          kill(signal) {
            childCalls.push(`kill:${signal}`);
            completion.resolve({ exitCode: 1 });
          },
          wait: () => completion.promise,
        };
      },
    },
  );
  await spawned.promise;
  process.emit("SIGINT", "SIGINT");
  const exitCode = await withTimeout(command, "start ignored SIGINT until the handshake budget.");

  expect(exitCode).toBe(1);
  expect(childCalls).toContain("kill:SIGKILL");
});

test("start kills a production child that never exits after a shutdown request", async () => {
  const project = await createTemporaryProject({ dist: { "main.mjs": "export {};\n" } });
  projects.push(project);
  const output = recordingReporter();
  const childCalls: string[] = [];
  const awaitingExit = Promise.withResolvers<void>();

  const command = runStartCommand(
    {
      cwd: project.projectRoot,
      projectDirectory: ".",
      reporter: output.reporter,
    },
    {
      shutdownGraceMilliseconds: 50,
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
          },
          // 关停请求被受理，子进程却永不退出——用户应用有个 settle 不了的 close 钩子时的样子。
          async requestShutdown(signal) {
            childCalls.push(`shutdown:${signal}`);
          },
          kill(signal) {
            childCalls.push(`kill:${signal}`);
            completion.resolve({ exitCode: 1 });
          },
          wait() {
            awaitingExit.resolve();
            return completion.promise;
          },
        };
      },
    },
  );
  // wait() 被调用即证明握手已完成，此刻的信号必然走转达路径而不是握手期排队。
  await awaitingExit.promise;
  process.emit("SIGINT", "SIGINT");
  const exitCode = await withTimeout(command, "start waited forever for a child that never exits.");

  expect(exitCode).toBe(1);
  expect(childCalls).toContain("kill:SIGKILL");
});
