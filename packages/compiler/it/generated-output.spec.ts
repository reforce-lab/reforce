import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  GeneratedDependency,
  GeneratedExecutionPlans,
  GeneratedSourceReference,
} from "@reforce/context/generated-runtime";
import type { TemporaryProject } from "@reforce/tooling-testing";
import { createCompiler, type GeneratedFile } from "@/index";
import {
  type CompilerProjectName,
  type CompileSuccess,
  compileProjectOrThrow,
  createCompilerProject,
  createPositiveApplication,
  resolveProjectOrThrow,
} from "./support/project";

type GeneratedFilePath = GeneratedFile["path"];

const temporaryProjects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});
async function copiedProject(name: CompilerProjectName): Promise<TemporaryProject> {
  const project = await createCompilerProject(name);
  temporaryProjects.push(project);
  return project;
}

async function positiveApplication(): Promise<TemporaryProject> {
  const project = await createPositiveApplication();
  temporaryProjects.push(project);
  return project;
}

async function linkWorkspacePackage(monorepoRoot: string): Promise<void> {
  const target = path.join(monorepoRoot, "node_modules", "@fixture", "shared");
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(
    path.join(monorepoRoot, "packages", "shared"),
    target,
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function writeGeneratedFiles(
  projectRoot: string,
  files: readonly GeneratedFile[],
): Promise<void> {
  const generatedDirectory = path.join(projectRoot, ".reforce", "generated");
  await mkdir(generatedDirectory, { recursive: true });
  await Promise.all(
    files.map((file) => writeFile(path.join(generatedDirectory, file.path), file.content)),
  );
}

function generatedBytes(files: readonly GeneratedFile[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(files.map((file) => [file.path, file.content])));
}

interface ManifestSymbolReference {
  readonly displayName: string;
  readonly moduleSpecifier: string;
  readonly exportName: string;
  readonly declaration?: GeneratedSourceReference;
}

interface ManifestBean {
  readonly id: string;
  readonly kind: "class" | "factory";
  readonly source: GeneratedSourceReference;
  readonly runtimeExport: {
    readonly moduleSpecifier: string;
    readonly exportName: string;
  };
  readonly dependencies: readonly GeneratedDependency[];
  readonly qualifiers: readonly {
    readonly interface: ManifestSymbolReference;
    readonly member: string;
  }[];
  readonly lifecycle: {
    readonly start: boolean;
    readonly close: boolean;
    readonly dispose: boolean;
  };
}

interface GeneratedManifest {
  readonly schemaVersion: 1;
  readonly beans: readonly ManifestBean[];
  readonly plans: GeneratedExecutionPlans;
}

function generatedContent(result: CompileSuccess, filePath: GeneratedFilePath): string {
  const content = result.files.find((file) => file.path === filePath)?.content;
  if (content === undefined) {
    throw new Error(`Missing generated file ${filePath}`);
  }
  return content;
}

function manifestOf(result: CompileSuccess): GeneratedManifest {
  return JSON.parse(generatedContent(result, "manifest.json"));
}

function manifestBean(manifest: GeneratedManifest, id: string): ManifestBean {
  const bean = manifest.beans.find((candidate) => candidate.id === id);
  if (bean === undefined) {
    throw new Error(`Missing manifest Bean ${id}`);
  }
  return bean;
}

function registrationBlock(beans: string, index: number): string {
  const start = beans.indexOf(`const registration${index} =`);
  const end = beans.indexOf("\n\n", start);
  if (start < 0 || end < 0) {
    throw new Error(`Missing generated registration ${index}`);
  }
  return beans.slice(start, end);
}

function embeddedData(value: unknown): string {
  return JSON.stringify(value, undefined, 2)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
    .trimStart();
}

function occurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

describe("generated output", () => {
  test("returns the complete generated file set in memory", async () => {
    const input = await positiveApplication();
    const compiler = createCompiler();
    const project = await resolveProjectOrThrow(compiler, input.projectRoot);

    const result = await compileProjectOrThrow(compiler, project);

    expect(result.files.map((file) => file.path)).toEqual([
      "beans.ts",
      "qualifiers.d.ts",
      "manifest.json",
      "bootstrap.ts",
    ]);
  });

  test("keeps generated output isolated between sibling applications", async () => {
    const input = await copiedProject("monorepo-application-selection");
    await linkWorkspacePackage(input.projectRoot);
    const apiRoot = path.join(input.projectRoot, "apps", "api");
    const adminRoot = path.join(input.projectRoot, "apps", "admin");
    const apiCompiler = createCompiler();
    const adminCompiler = createCompiler();
    const [apiProject, adminProject] = await Promise.all([
      resolveProjectOrThrow(apiCompiler, apiRoot),
      resolveProjectOrThrow(adminCompiler, adminRoot),
    ]);
    const [apiResult, adminResult] = await Promise.all([
      compileProjectOrThrow(apiCompiler, apiProject),
      compileProjectOrThrow(adminCompiler, adminProject),
    ]);

    await Promise.all([
      writeGeneratedFiles(apiRoot, apiResult.files),
      writeGeneratedFiles(adminRoot, adminResult.files),
    ]);
    const [apiManifest, adminManifest] = await Promise.all([
      readFile(path.join(apiRoot, ".reforce", "generated", "manifest.json"), "utf8"),
      readFile(path.join(adminRoot, ".reforce", "generated", "manifest.json"), "utf8"),
    ]);

    expect(apiManifest).toContain("ApiService");
    expect(apiManifest).not.toContain("AdminService");
    expect(adminManifest).toContain("AdminService");
    expect(adminManifest).not.toContain("ApiService");
  });

  test("emits identical bytes for cold, warm, and shuffled inputs", async () => {
    const ordered = await copiedProject("deterministic-cycle-generation");
    const shuffled = await copiedProject("deterministic-cycle-generation");
    const shuffledConfigPath = path.join(shuffled.projectRoot, "tsconfig.json");
    const shuffledConfig = await readFile(shuffledConfigPath, "utf8");
    await writeFile(
      shuffledConfigPath,
      shuffledConfig.replace('["src/zeta.ts", "src/alpha.ts"]', '["src/alpha.ts", "src/zeta.ts"]'),
    );
    const warmCompiler = createCompiler();
    const coldCompiler = createCompiler();
    const shuffledCompiler = createCompiler();
    const warmProject = await resolveProjectOrThrow(warmCompiler, ordered.projectRoot);
    const coldProject = await resolveProjectOrThrow(coldCompiler, ordered.projectRoot);
    const shuffledProject = await resolveProjectOrThrow(shuffledCompiler, shuffled.projectRoot);

    const cold = await compileProjectOrThrow(coldCompiler, coldProject);
    const firstWarm = await compileProjectOrThrow(warmCompiler, warmProject);
    const secondWarm = await compileProjectOrThrow(warmCompiler, warmProject);
    const shuffledResult = await compileProjectOrThrow(shuffledCompiler, shuffledProject);

    expect(generatedBytes(firstWarm.files)).toEqual(generatedBytes(cold.files));
    expect(generatedBytes(secondWarm.files)).toEqual(generatedBytes(cold.files));
    expect(generatedBytes(shuffledResult.files)).toEqual(generatedBytes(cold.files));
  });

  test("keeps cycle proxy and lifecycle ordering deterministic", async () => {
    const input = await copiedProject("deterministic-cycle-generation");
    const compiler = createCompiler();
    const project = await resolveProjectOrThrow(compiler, input.projectRoot);

    const result = await compileProjectOrThrow(compiler, project);

    const manifest = generatedContent(result, "manifest.json");
    expect(manifest.match(/"mode": "cycle-proxy"/gu)).toHaveLength(1);
    expect(manifest).toMatch(
      /"mode": "cycle-proxy"[\s\S]*?"targetId": "src\/alpha\.ts#AlphaService"/u,
    );
    expect(manifest).toContain(
      '"startActionOrder": [\n      "src/alpha.ts#AlphaService",\n      "src/zeta.ts#ZetaService"\n    ]',
    );
    expect(manifest).toContain(
      '"cleanupActionOrder": [\n      "src/zeta.ts#ZetaService",\n      "src/alpha.ts#AlphaService"\n    ]',
    );
  });

  test("emits dependency sources for complete constructor parameters", async () => {
    const input = await copiedProject("generated-runtime-contract");
    const compiler = createCompiler();
    const project = await resolveProjectOrThrow(compiler, input.projectRoot);
    const sourceText = await readFile(
      path.join(input.projectRoot, "src", "application.ts"),
      "utf8",
    );

    const result = await compileProjectOrThrow(compiler, project);
    const manifest = manifestOf(result);
    const parameterSources = manifest.beans.flatMap((bean) =>
      bean.dependencies.map((dependency) =>
        sourceText.slice(dependency.source.start.offset, dependency.source.end.offset),
      ),
    );

    expect(parameterSources).toEqual([
      "readonly beta: BetaService",
      "readonly resource: Lazy<ManagedResource>",
      "readonly alpha: AlphaService",
    ]);
  });

  test("merges interface augmentations that target the same module", async () => {
    const input = await copiedProject("generated-runtime-contract");
    const compiler = createCompiler();
    const project = await resolveProjectOrThrow(compiler, input.projectRoot);

    const result = await compileProjectOrThrow(compiler, project);
    const qualifiers = generatedContent(result, "qualifiers.d.ts");
    const target = 'declare module "../../src/contracts.js"';

    expect(occurrences(qualifiers, target)).toBe(1);
    expect(qualifiers).toContain(
      [
        `${target} {`,
        "  namespace AlphaPort {",
        '    type AlphaService = QualifiedBean<InterfaceType0, "src/application.ts#AlphaService">;',
        "  }",
        "",
        "  namespace BetaPort {",
        '    type BetaService = QualifiedBean<InterfaceType1, "src/application.ts#BetaService">;',
        "  }",
        "}",
      ].join("\n"),
    );
  });

  test("keeps registration, manifest, qualifier, and plan data consistent", async () => {
    const input = await copiedProject("generated-runtime-contract");
    const compiler = createCompiler();
    const project = await resolveProjectOrThrow(compiler, input.projectRoot);

    const result = await compileProjectOrThrow(compiler, project);
    const beans = generatedContent(result, "beans.ts");
    const qualifiers = generatedContent(result, "qualifiers.d.ts");
    const manifest = manifestOf(result);
    const dependencies = manifest.beans.flatMap((bean) => bean.dependencies);

    expect(new Set(dependencies.map((dependency) => dependency.mode))).toEqual(
      new Set(["eager", "cycle-proxy", "explicit-lazy"]),
    );
    expect(manifestBean(manifest, "src/application.ts#AlphaService").lifecycle).toEqual({
      start: true,
      close: true,
      dispose: false,
    });
    expect(manifestBean(manifest, "src/application.ts#managedResource").lifecycle).toEqual({
      start: false,
      close: false,
      dispose: true,
    });

    for (const [index, bean] of manifest.beans.entries()) {
      const registration = registrationBlock(beans, index);
      expect(beans).toContain(
        `import { ${bean.runtimeExport.exportName} as beanTarget${index} } from ${JSON.stringify(bean.runtimeExport.moduleSpecifier)};`,
      );
      expect(registration).toContain(`id: ${JSON.stringify(bean.id)},`);
      expect(registration).toContain(`source: ${embeddedData(bean.source)},`);

      if (bean.kind === "factory") {
        expect(bean.dependencies).toEqual([]);
        expect(registration).toContain(`const registration${index} = factoryBean({`);
        expect(registration).toContain(`definition: beanTarget${index},`);
        expect(registration).not.toContain("dependencies:");
      } else {
        const argumentsList = bean.dependencies
          .map((dependency) =>
            dependency.mode === "explicit-lazy"
              ? `resolver.lazy(${dependency.parameterIndex})`
              : `resolver.resolve(${dependency.parameterIndex})`,
          )
          .join(", ");
        expect(registration).toContain(`const registration${index} = classBean({`);
        expect(registration).toContain(`dependencies: ${embeddedData(bean.dependencies)},`);
        expect(registration).toContain(
          `create: (resolver) => new beanTarget${index}(${argumentsList}),`,
        );
        expect(registration.includes("start: (bean) => bean.onContextStart(),")).toBe(
          bean.lifecycle.start,
        );
        expect(registration.includes("close: (bean) => bean.onContextClose(),")).toBe(
          bean.lifecycle.close,
        );
      }

      for (const qualifier of bean.qualifiers) {
        expect(qualifiers).toContain(
          `declare module ${JSON.stringify(qualifier.interface.moduleSpecifier)}`,
        );
        const memberLine = qualifiers
          .split("\n")
          .find((line) => line.includes(`type ${qualifier.member} = QualifiedBean<`));
        expect(memberLine).toContain(JSON.stringify(bean.id));
      }
    }

    expect(beans).toContain(`plans: ${embeddedData(manifest.plans)},`);
  });
});
