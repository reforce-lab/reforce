import { afterEach, expect, test } from "bun:test";
import { rm, symlink } from "node:fs/promises";
import path from "node:path";
import { yukuFrontend } from "@reforce/compiler-yuku";
import {
  createTemporaryProject,
  type TemporaryProject,
  writeFixtureTree,
} from "@reforce/tooling-testing";
import { createCompiler } from "#internal/index";

const temporaryProjects: TemporaryProject[] = [];

const applicationConfig = `${JSON.stringify({
  compilerOptions: {
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    target: "ESNext",
  },
  include: ["src", ".reforce/generated/**/*.d.ts"],
})}\n`;

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

async function createApplications(): Promise<TemporaryProject> {
  const temporary = await createTemporaryProject();
  temporaryProjects.push(temporary);
  await writeFixtureTree(temporary.projectRoot, {
    "app-a": {
      src: { "application.ts": "export class ApplicationA {}\n" },
      "tsconfig.json": applicationConfig,
    },
    "app-b": {
      src: { "application.ts": "export class ApplicationB {}\n" },
      "tsconfig.json": applicationConfig,
    },
  });
  return temporary;
}

async function replaceDirectoryLink(link: string, target: string): Promise<void> {
  await rm(link, { force: true, recursive: true });
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

test("compile rejects a project directory link retargeted after resolution", async () => {
  const temporary = await createApplications();
  const first = path.join(temporary.projectRoot, "app-a");
  const second = path.join(temporary.projectRoot, "app-b");
  const selected = path.join(temporary.projectRoot, "selected-app");
  await symlink(first, selected, process.platform === "win32" ? "junction" : "dir");
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: selected });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }

  await replaceDirectoryLink(selected, second);
  const result = await compiler.compile({ project: resolution.project, frontend: yukuFrontend });

  expect(result.status).toBe("failure");
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    "PROJECT_CONFIG_CHANGED",
  ]);
});

test("compile rejects an explicit config link retargeted after resolution", async () => {
  const temporary = await createApplications();
  const first = path.join(temporary.projectRoot, "app-a");
  const second = path.join(temporary.projectRoot, "app-b");
  const selected = path.join(temporary.projectRoot, "selected-config");
  await symlink(first, selected, process.platform === "win32" ? "junction" : "dir");
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({
    projectDirectory: temporary.projectRoot,
    tsconfigPath: path.join(selected, "tsconfig.json"),
  });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }

  await replaceDirectoryLink(selected, second);
  const result = await compiler.compile({ project: resolution.project, frontend: yukuFrontend });

  expect(result.status).toBe("failure");
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    "PROJECT_CONFIG_CHANGED",
  ]);
});
