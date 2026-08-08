import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { afterAll, expect, test } from "vitest";
import { type CompileResult, createCompiler, type GeneratedFile } from "@/index";

type CompileSuccess = Extract<CompileResult, { readonly status: "success" }>;
type GeneratedFilePath = GeneratedFile["path"];

// 评审缺陷 A2（#314）：`reforce explain MISSING_BEAN` 的长文曾断言「编译器只看从应用入口
// （传递）导出的类」。实现从未有过入口可达性过滤——source discovery 消费 leaf tsconfig
// include 展开的全部源文件（project/source-files.ts），provider 无需被任何文件 import 或
// re-export。本 spec 把该行为钉死成回归测试；explain 长文（cli/src/explain/codes.ts 的
// MISSING_BEAN）的排查建议以此为事实依据。

const temporaryProjects: TemporaryProject[] = [];

function applicationTsconfig(): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      experimentalDecorators: false,
      emitDecoratorMetadata: false,
    },
    include: ["src", ".reforce/generated/**/*.ts"],
  })}\n`;
}

function generatedContent(result: CompileSuccess, filePath: GeneratedFilePath): string {
  const content = result.files.find((file) => file.path === filePath)?.content;
  if (content === undefined) {
    throw new Error(`Missing generated file ${filePath}.`);
  }
  return content;
}

function dependencyTarget(result: CompileSuccess, beanId: string, parameterIndex: number): string {
  const manifest: unknown = JSON.parse(generatedContent(result, "manifest.json"));
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error("Generated manifest must be an object.");
  }
  const beans: unknown = Reflect.get(manifest, "beans");
  if (!Array.isArray(beans)) {
    throw new Error("Generated manifest must contain Beans.");
  }
  const bean = beans.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      Reflect.get(candidate, "id") === beanId,
  );
  if (typeof bean !== "object" || bean === null) {
    throw new Error(`Missing generated Bean ${beanId}.`);
  }
  const dependencies: unknown = Reflect.get(bean, "dependencies");
  if (!Array.isArray(dependencies)) {
    throw new Error(`Generated Bean ${beanId} must contain dependencies.`);
  }
  const dependency = dependencies.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      Reflect.get(candidate, "parameterIndex") === parameterIndex,
  );
  if (typeof dependency !== "object" || dependency === null) {
    throw new Error(`Missing dependency ${parameterIndex} for ${beanId}.`);
  }
  const targetId: unknown = Reflect.get(dependency, "targetId");
  if (typeof targetId !== "string") {
    throw new Error(`Dependency ${parameterIndex} for ${beanId} must have a target ID.`);
  }
  return targetId;
}

afterAll(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

test("discovers and wires providers in a file no other file imports or re-exports", async () => {
  const project = await createTemporaryProject({
    "tsconfig.json": applicationTsconfig(),
    src: {
      // 入口不 import 应用内任何模块：standalone.ts 对整个 import 图完全孤立。
      "application.ts": [
        'import { Injectable } from "@reforce/core";',
        "@Injectable() export class EntryProbe {}",
      ].join("\n"),
      "standalone.ts": [
        'import { Injectable } from "@reforce/core";',
        "@Injectable() export class StandaloneRepository {}",
        "@Injectable() export class StandaloneService {",
        "  constructor(readonly repository: StandaloneRepository) {}",
        "}",
      ].join("\n"),
    },
  });
  temporaryProjects.push(project);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }

  const result = await compiler.compile({ project: resolution.project });

  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  expect(dependencyTarget(result, "src/standalone.ts#StandaloneService", 0)).toBe(
    "src/standalone.ts#StandaloneRepository",
  );
});
