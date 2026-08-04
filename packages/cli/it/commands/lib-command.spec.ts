import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { runLibCommand } from "@/commands/lib";
import { runCli } from "@/commands/run-cli";
import { recordingReporter } from "../support/recording-reporter";

// reforce lib 命令 IT（ADR 0004 M2，#147）：产物写包根、exports subpath 只校验不改写、
// 编译诊断按 lib 命令面透传。库模式编译语义本身由 compiler 的 library-compile IT 钉住。

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

const libraryExports = {
  ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
  "./reforce": { types: "./reforce.d.ts", default: "./reforce.js" },
  "./reforce-meta": "./reforce-meta.json",
};

async function createLibrary(
  options: {
    readonly exports?: Record<string, unknown>;
    readonly sources?: Record<string, string>;
  } = {},
): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    "package.json": `${JSON.stringify({
      name: "@acme/starter-widget",
      version: "1.0.0",
      type: "module",
      exports: options.exports ?? libraryExports,
    })}\n`,
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
      },
      include: ["src"],
    })}\n`,
    src: options.sources ?? {
      "index.ts": [
        'import { Injectable } from "@reforce/context";',
        "",
        "@Injectable()",
        "export class Widget {}",
        "",
      ].join("\n"),
    },
    dist: {
      "index.d.ts": "export declare class Widget {}\n",
      "index.js": "export class Widget {}\n",
    },
  });
  projects.push(project);
  return project;
}

test("lib writes meta and registration handles into the package root", async () => {
  const project = await createLibrary();
  const output = recordingReporter();

  const exitCode = await runLibCommand({
    cwd: project.projectRoot,
    projectDirectory: ".",
    reporter: output.reporter,
  });

  expect(exitCode).toBe(0);
  expect(output.events).toHaveLength(1);
  expect(output.events[0]).toMatchObject({
    kind: "success",
    command: "lib",
    message: "Generated starter meta for @acme/starter-widget.",
  });
  const meta = JSON.parse(await readFile(join(project.projectRoot, "reforce-meta.json"), "utf8"));
  expect(meta.schemaVersion).toBe(1);
  expect(meta.beans.map((bean: { id: string }) => bean.id)).toEqual([
    "@acme/starter-widget#Widget",
  ]);
  expect(await readFile(join(project.projectRoot, "reforce.js"), "utf8")).toContain(
    "export default",
  );
  expect(await readFile(join(project.projectRoot, "reforce.d.ts"), "utf8")).toContain(
    "StarterDefinition",
  );
});

test("lib fails with PACKAGE_EXPORTS_INVALID when the meta subpath is missing", async () => {
  const project = await createLibrary({
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./reforce": { types: "./reforce.d.ts", default: "./reforce.js" },
    },
  });
  const output = recordingReporter();

  const exitCode = await runLibCommand({
    cwd: project.projectRoot,
    projectDirectory: ".",
    reporter: output.reporter,
  });

  expect(exitCode).toBe(1);
  expect(output.events).toHaveLength(1);
  expect(output.events[0]).toMatchObject({
    kind: "failure",
    command: "lib",
    phase: "project",
    code: "PACKAGE_EXPORTS_INVALID",
  });
  // 产物仍然写盘：作者补一行 exports 即可发布，不需要重跑编译。
  const meta = JSON.parse(await readFile(join(project.projectRoot, "reforce-meta.json"), "utf8"));
  expect(meta.schemaVersion).toBe(1);
});

test("lib reports compiler diagnostics for unsupported library declarations", async () => {
  const project = await createLibrary({
    sources: {
      "index.ts": [
        'import { defineBean } from "@reforce/context";',
        "",
        "export const clock = defineBean({",
        "  create: () => ({ now: () => 0 }),",
        "});",
        "",
      ].join("\n"),
    },
  });
  const output = recordingReporter();

  const exitCode = await runLibCommand({
    cwd: project.projectRoot,
    projectDirectory: ".",
    reporter: output.reporter,
  });

  expect(exitCode).toBe(1);
  expect(output.events.length).toBeGreaterThan(0);
  expect(output.events[0]).toMatchObject({
    kind: "diagnostic",
    command: "lib",
    phase: "compiler",
  });
  expect(output.events[0]).toHaveProperty("diagnostic.code", "UNSUPPORTED_LIBRARY_DECLARATION");
});

test("runCli dispatches the lib command with compile options", async () => {
  const project = await createLibrary();
  const output = recordingReporter();

  const exitCode = await runCli({
    argv: [process.execPath, "reforce", "lib", "--project", "."],
    cwd: project.projectRoot,
    reporter: output.reporter,
  });

  expect(exitCode).toBe(0);
  expect(output.events[0]).toMatchObject({ kind: "success", command: "lib" });
});
