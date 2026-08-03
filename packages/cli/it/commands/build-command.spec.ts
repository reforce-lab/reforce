import { afterEach, expect, test } from "bun:test";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { runBuildCommand } from "@/commands/build";
import type { CliReporterEvent, Reporter } from "@/reporter";

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
      include: ["src", ".reforce/generated/**/*.d.ts"],
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
