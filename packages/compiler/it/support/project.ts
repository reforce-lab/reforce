import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTemporaryProject,
  type TemporaryProject,
  writeProjectTree,
} from "@reforce/tooling-testing";
import type { CompileResult, createCompiler, ProjectResolutionResult } from "@/index";
import {
  type CompilerProjectName,
  compilerProjectTrees,
  positiveApplicationTree,
} from "./project-trees";

export type { CompilerProjectName } from "./project-trees";

export type Compiler = ReturnType<typeof createCompiler>;
export type CompileSuccess = Extract<CompileResult, { readonly status: "success" }>;
export type ResolvedProject = Extract<
  ProjectResolutionResult,
  { readonly status: "success" }
>["project"];

const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));

async function linkPackage(
  projectRoot: string,
  packageName: string,
  packageRoot: string,
): Promise<void> {
  const target = path.join(projectRoot, "node_modules", ...packageName.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(packageRoot, target, process.platform === "win32" ? "junction" : "dir");
}

export async function linkApplicationPackages(projectRoot: string): Promise<void> {
  await Promise.all([
    linkPackage(projectRoot, "@reforce/context", path.join(repositoryRoot, "packages", "context")),
    linkPackage(
      projectRoot,
      "@types/node",
      path.dirname(fileURLToPath(import.meta.resolve("@types/node/package.json"))),
    ),
  ]);
}

export async function linkConfigPackage(projectRoot: string): Promise<void> {
  await linkPackage(
    projectRoot,
    "@reforce/config",
    path.join(repositoryRoot, "packages", "config"),
  );
}

export async function linkWebPackage(projectRoot: string): Promise<void> {
  await linkPackage(projectRoot, "@reforce/web", path.join(repositoryRoot, "packages", "web"));
}

export async function linkTransactionPackage(projectRoot: string): Promise<void> {
  await linkPackage(
    projectRoot,
    "@reforce/transaction",
    path.join(repositoryRoot, "packages", "transaction"),
  );
}

export async function linkLoggingPackage(projectRoot: string): Promise<void> {
  await linkPackage(
    projectRoot,
    "@reforce/logging",
    path.join(repositoryRoot, "packages", "logging"),
  );
}
export async function writePositiveApplication(projectRoot: string): Promise<void> {
  await writeProjectTree(projectRoot, positiveApplicationTree);
  await linkApplicationPackages(projectRoot);
}

export async function createPositiveApplication(): Promise<TemporaryProject> {
  const temporary = await createTemporaryProject();
  try {
    await writePositiveApplication(temporary.projectRoot);
    return temporary;
  } catch (error) {
    await temporary.cleanup();
    throw error;
  }
}

export async function addQualifiedSelectionProbe(projectRoot: string): Promise<void> {
  await writeFile(
    path.join(projectRoot, "src", "qualified-selection.ts"),
    [
      'import { Injectable } from "@reforce/context";',
      'import type { DefaultPort, UniquePort } from "@/providers";',
      "",
      "@Injectable()",
      "export class QualifiedSelectionProbe {",
      "  constructor(",
      "    readonly defaultPort: DefaultPort,",
      "    readonly qualifiedPort: DefaultPort.Fallback,",
      "    readonly uniquePort: UniquePort,",
      "  ) {}",
      "",
      "  values(): readonly string[] {",
      "    return [this.defaultPort.value(), this.qualifiedPort.value(), this.uniquePort.value()];",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
}

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

export async function createCompilerProject(name: CompilerProjectName): Promise<TemporaryProject> {
  const temporary = await createTemporaryProject();
  try {
    await writeProjectTree(temporary.projectRoot, compilerProjectTrees[name]);
    return temporary;
  } catch (error) {
    await temporary.cleanup();
    throw error;
  }
}

export async function resolveProjectOrThrow(
  compiler: Compiler,
  projectDirectory: string,
  tsconfigPath?: string,
): Promise<ResolvedProject> {
  const result = await compiler.resolveProject({
    projectDirectory,
    tsconfigPath,
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
