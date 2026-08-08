import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { afterEach, expect, test } from "vitest";
import { runBuildCommand } from "@/commands/build";
import { recordingReporter } from "../support/recording-reporter";
import { installContextDistribution } from "../support/watch-harness";

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

async function createApplication(transactionKind: "generated" | "dist"): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    ".reforce": {
      transactions: {
        [transactionKind]: {
          "invalid.token": {},
        },
      },
    },
    src: { "application.ts": "export {};\n" },
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        experimentalDecorators: false,
        emitDecoratorMetadata: false,
      },
      include: ["src", ".reforce/generated/**/*.ts"],
    })}\n`,
  });
  projects.push(project);
  return project;
}

test("build preserves a generated transaction recovery failure", async () => {
  const project = await createApplication("generated");
  const output = recordingReporter();

  const exitCode = await runBuildCommand({
    cwd: project.projectRoot,
    projectDirectory: ".",
    reporter: output.reporter,
  });

  expect(exitCode).toBe(1);
  expect(output.events).toHaveLength(1);
  expect(output.events[0]).toMatchObject({
    kind: "failure",
    command: "build",
    phase: "generated-commit",
    code: "GENERATED_TRANSACTION_FAILED",
  });
  expect(output.events[0]).toHaveProperty("cause.code", "GENERATED_TRANSACTION_FAILED");
});

test("build preserves a dist transaction recovery failure", async () => {
  const project = await createApplication("dist");
  const output = recordingReporter();

  const exitCode = await runBuildCommand({
    cwd: project.projectRoot,
    projectDirectory: ".",
    reporter: output.reporter,
  });

  expect(exitCode).toBe(1);
  expect(output.events).toHaveLength(1);
  expect(output.events[0]).toMatchObject({
    kind: "failure",
    command: "build",
    phase: "dist-commit",
    code: "DIST_TRANSACTION_FAILED",
  });
  expect(output.events[0]).toHaveProperty("cause.code", "DIST_TRANSACTION_FAILED");
});

test("build reports a lease release failure without replacing the transaction failure", async () => {
  const project = await createApplication("generated");
  const cleanupOrder: string[] = [];
  const output = recordingReporter(() => cleanupOrder.push("flush"));
  const releaseError = new Error("release failed");

  const exitCode = await runBuildCommand(
    {
      cwd: project.projectRoot,
      projectDirectory: ".",
      reporter: output.reporter,
    },
    {
      async releaseLease(lease) {
        cleanupOrder.push("release");
        await lease.release();
        throw releaseError;
      },
    },
  );

  expect(exitCode).toBe(1);
  expect(output.flushCount).toBe(2);
  expect(output.events).toHaveLength(2);
  expect(output.events[0]).toMatchObject({ code: "GENERATED_TRANSACTION_FAILED" });
  expect(output.events[1]).toMatchObject({
    kind: "failure",
    command: "build",
    phase: "shutdown",
    code: "SHUTDOWN_FAILED",
  });
  const primaryEvent = output.events[0];
  if (primaryEvent?.kind !== "failure") {
    throw new Error("Expected the transaction failure event first.");
  }
  expect(output.events[1]).toHaveProperty("cause.errors", [primaryEvent.cause, releaseError]);
  expect(cleanupOrder).toEqual(["flush", "release", "flush"]);
});

// —— 警告生命周期（RFC 0011 OM2，#242）——
// UNUSED_SUPPRESSION 是本仓第一条 warning，用它端到端验「warning 随 success 返回 → CLI 上报
// → --deny-warnings 退 1」这条链路。

async function createWarningApplication(): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    src: {
      "application.ts": [
        "// reforce-ignore MISSING_BEAN: nothing here reports it",
        'export const marker = "ok";',
        "",
      ].join("\n"),
    },
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        experimentalDecorators: false,
        emitDecoratorMetadata: false,
      },
      include: ["src", ".reforce/generated/**/*.ts"],
    })}\n`,
  });
  projects.push(project);
  // 这三条要走完整的生产构建（编译 + 打包），所以项目里必须有真实的 @reforce/core dist；
  // 上面那两条只走到事务恢复就返回，用不着。
  await installContextDistribution(project.projectRoot);
  return project;
}

test("build reports a warning and still succeeds", async () => {
  const project = await createWarningApplication();
  const output = recordingReporter();

  const exitCode = await runBuildCommand({
    cwd: project.projectRoot,
    projectDirectory: ".",
    reporter: output.reporter,
  });

  expect(exitCode).toBe(0);
  expect(
    output.events.filter(
      (event) => event.kind === "diagnostic" && event.diagnostic.code === "UNUSED_SUPPRESSION",
    ),
  ).toHaveLength(1);
}, 60_000);

// 产物照常落盘：图是完整的。非零退出只是给 CI 的闸门信号。
test("--deny-warnings turns a reported warning into a non-zero exit", async () => {
  const project = await createWarningApplication();
  const output = recordingReporter();

  const exitCode = await runBuildCommand({
    cwd: project.projectRoot,
    projectDirectory: ".",
    reporter: output.reporter,
    diagnosticPolicy: { denyWarnings: true, levels: new Map() },
  });

  expect(exitCode).toBe(1);
  expect(output.events.some((event) => event.kind === "success")).toBe(true);
}, 60_000);

test("--diagnostic-level CODE=off silences the warning entirely", async () => {
  const project = await createWarningApplication();
  const output = recordingReporter();

  const exitCode = await runBuildCommand({
    cwd: project.projectRoot,
    projectDirectory: ".",
    reporter: output.reporter,
    diagnosticPolicy: {
      denyWarnings: true,
      levels: new Map([["UNUSED_SUPPRESSION", "off"]]),
    },
  });

  expect(exitCode).toBe(0);
  expect(output.events.some((event) => event.kind === "diagnostic")).toBe(false);
}, 60_000);

test("--diagnostic-level CODE=error fails the command without --deny-warnings", async () => {
  const project = await createWarningApplication();
  const output = recordingReporter();

  const exitCode = await runBuildCommand({
    cwd: project.projectRoot,
    projectDirectory: ".",
    reporter: output.reporter,
    diagnosticPolicy: {
      denyWarnings: false,
      levels: new Map([["UNUSED_SUPPRESSION", "error"]]),
    },
  });

  expect(exitCode).toBe(1);
}, 60_000);
