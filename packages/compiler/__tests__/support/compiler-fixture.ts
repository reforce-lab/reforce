import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyFixtureTree,
  createTemporaryProject,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import type { CompileResult, createCompiler, ProjectResolutionResult } from "../../src/index";

export type Compiler = ReturnType<typeof createCompiler>;
export type CompileSuccess = Extract<CompileResult, { readonly status: "success" }>;
export type ResolvedProject = Extract<
  ProjectResolutionResult,
  { readonly status: "success" }
>["project"];

const fixtureDirectory = fileURLToPath(new URL("../../fixtures/", import.meta.url));

export function applicationTsconfig(
  include: readonly string[] = ["src", ".reforce/generated/**/*.d.ts"],
): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
    },
    include,
  })}\n`;
}

export async function copyCompilerFixture(name: string): Promise<TemporaryProject> {
  const temporary = await createTemporaryProject();
  await copyFixtureTree(path.join(fixtureDirectory, name, "project"), temporary.projectRoot);
  return temporary;
}

export async function resolveProjectOrThrow(
  compiler: Compiler,
  projectDirectory: string,
  tsconfigPath?: string,
): Promise<ResolvedProject> {
  const result = await compiler.resolveProject({
    projectDirectory,
    ...(tsconfigPath === undefined ? {} : { tsconfigPath }),
  });
  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result.project;
}

export async function compileProjectOrThrow(
  compiler: Compiler,
  project: ResolvedProject,
): Promise<CompileSuccess> {
  const result = await compiler.compile({ project });
  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}
