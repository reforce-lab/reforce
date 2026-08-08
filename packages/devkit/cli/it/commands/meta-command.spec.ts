import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { afterEach, expect, test } from "vitest";
import { runMetaCheckCommand } from "@/commands/meta";
import { runCli } from "@/commands/run-cli";
import { recordingReporter } from "../support/recording-reporter";

// reforce meta check IT（#369）：这条命令不编译、不要应用，只回答「这个包装到别人的应用里能不能
// 接上」。判定本体的用例在 @reforce/starter-meta 的单测里；这里守的是 CLI 面——退出码、事件形态，
// 以及「不需要 tsconfig、不需要源码」这条准入。

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

const packageName = "@acme/starter-widget";

function metaBytes(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    starterDeps: [],
    symbols: [{ id: `${packageName}#Widget`, file: "dist/index.d.ts", subpaths: ["."] }],
    beans: [
      {
        id: `${packageName}#Widget`,
        runtimeExport: { module: packageName, export: "Widget" },
        provides: [`${packageName}#Widget`],
        dependencies: [],
      },
    ],
    ...overrides,
  })}\n`;
}

async function createStarter(
  options: { readonly exports?: Record<string, unknown>; readonly meta?: string } = {},
): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    "package.json": `${JSON.stringify({
      name: packageName,
      version: "1.0.0",
      type: "module",
      exports: options.exports ?? {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./reforce-meta": "./reforce-meta.json",
      },
    })}\n`,
    "reforce-meta.json": options.meta ?? metaBytes(),
    dist: { "index.d.ts": "export declare class Widget {}\n" },
  });
  projects.push(project);
  return project;
}

test("meta check accepts a hand-written meta with no source spans and no tsconfig", async () => {
  const project = await createStarter();
  const output = recordingReporter();

  const exitCode = await runMetaCheckCommand({
    cwd: project.projectRoot,
    packageDirectory: ".",
    reporter: output.reporter,
  });

  expect(exitCode).toBe(0);
  expect(output.events[0]).toMatchObject({ kind: "success", command: "meta" });
});

test("meta check reports the exports contract with the same code reforce lib uses", async () => {
  const project = await createStarter({ exports: { ".": "./dist/index.js" } });
  const output = recordingReporter();

  const exitCode = await runMetaCheckCommand({
    cwd: project.projectRoot,
    packageDirectory: ".",
    reporter: output.reporter,
  });

  expect(exitCode).toBe(1);
  expect(output.events[0]).toMatchObject({
    kind: "failure",
    command: "meta",
    code: "PACKAGE_EXPORTS_INVALID",
  });
});

test("meta check reports a symbol anchored to a file the package does not ship", async () => {
  const missingAnchor = metaBytes({
    symbols: [{ id: `${packageName}#Widget`, file: "dist/widget.d.ts", subpaths: ["."] }],
  });
  const project = await createStarter({ meta: missingAnchor });
  const output = recordingReporter();

  const exitCode = await runMetaCheckCommand({
    cwd: project.projectRoot,
    packageDirectory: ".",
    reporter: output.reporter,
  });

  expect(exitCode).toBe(1);
  expect(output.events[0]).toMatchObject({
    kind: "diagnostic",
    command: "meta",
    diagnostic: { code: "INVALID_STARTER_META", severity: "error" },
  });
});

test("meta check fails when there is no meta to read at all", async () => {
  const project = await createTemporaryProject({
    "package.json": `${JSON.stringify({ name: packageName, exports: {} })}\n`,
  });
  projects.push(project);
  const output = recordingReporter();

  const exitCode = await runMetaCheckCommand({
    cwd: project.projectRoot,
    packageDirectory: ".",
    reporter: output.reporter,
  });

  expect(exitCode).toBe(1);
  expect(output.events[0]).toMatchObject({ kind: "failure", code: "ARTIFACT_INVALID" });
});

test("runCli dispatches meta check with the directory argument", async () => {
  const project = await createStarter();
  const output = recordingReporter();

  const exitCode = await runCli({
    argv: [process.execPath, "reforce", "meta", "check", "."],
    cwd: project.projectRoot,
    reporter: output.reporter,
  });

  expect(exitCode).toBe(0);
  expect(output.events[0]).toMatchObject({ kind: "success", command: "meta" });
});
