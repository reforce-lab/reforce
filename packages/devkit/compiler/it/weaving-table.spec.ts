import {
  createTemporaryProject,
  type ProjectTree,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterAll, describe, expect, test } from "vitest";
import { type CompileResult, createCompiler, type GeneratedFile } from "@/index";

// 织入表 IT（ADR 0008 AM1，#202 定案 4/5）：weaving.json 是可 diff 的纯数据面，钉住——
// 多标记叠加的链并集、(阶段, order, beanId) 排序、0 参标记记 null、空链方法在表、
// 两次编译逐字节一致，以及 manifest 追加依赖边的 parameterIndex 从用户参数后顺延。

type CompileSuccess = Extract<CompileResult, { readonly status: "success" }>;

const temporaryProjects: TemporaryProject[] = [];

afterAll(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

function applicationTsconfig(): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      paths: { "@/*": ["./src/*"] },
    },
    include: ["src", ".reforce/generated/**/*.ts"],
  })}\n`;
}

async function compileSourcesOrThrow(sources: Record<string, string>): Promise<CompileSuccess> {
  const tree: ProjectTree = { "tsconfig.json": applicationTsconfig(), src: sources };
  const project = await createTemporaryProject(tree);
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
  return result;
}

function generatedContent(result: CompileSuccess, filePath: GeneratedFile["path"]): string {
  const content = result.files.find((file) => file.path === filePath)?.content;
  if (content === undefined) {
    throw new Error(`Missing generated file ${filePath}`);
  }
  return content;
}

const interceptorClass = (name: string, marker: string, options: string): string =>
  [
    `@Interceptor({ marker: ${marker}${options} })`,
    `export class ${name} implements MethodInterceptor {`,
    "  async intercept(context: MethodInvocationContext, next: () => Promise<unknown>): Promise<unknown> {",
    "    return await next();",
    "  }",
    "}",
  ].join("\n");

const wovenSources: Record<string, string> = {
  "markers.ts": [
    'import { defineMethodMarker } from "@reforce/core";',
    'export const Audited = defineMethodMarker<{ label: string }>("audited");',
    'export const Traced = defineMethodMarker<{ detail: boolean } | undefined>("traced");',
    'export const Bare = defineMethodMarker("bare");',
  ].join("\n"),
  "interceptors.ts": [
    'import { Injectable, Interceptor } from "@reforce/core";',
    'import type { MethodInterceptor, MethodInvocationContext } from "@reforce/core";',
    'import { Audited, Traced } from "@/markers";',
    interceptorClass("TraceInterceptor", "Traced", ', phase: "observability"'),
    interceptorClass("CacheInterceptor", "Audited", ', phase: "cache"'),
    interceptorClass("EarlyAuditInterceptor", "Audited", ", order: -1"),
    interceptorClass("AuditInterceptor", "Audited", ", order: 1"),
  ].join("\n"),
  "clock.ts": [
    'import { Injectable } from "@reforce/core";',
    "@Injectable()",
    "export class Clock {",
    "  now(): number {",
    "    return 0;",
    "  }",
    "}",
  ].join("\n"),
  "service.ts": [
    'import { Injectable } from "@reforce/core";',
    'import { Audited, Bare, Traced } from "@/markers";',
    'import { Clock } from "@/clock";',
    "@Injectable()",
    "export class Repo {",
    "  constructor(private readonly clock: Clock) {}",
    "",
    '  @Audited({ label: "save" })',
    "  @Traced()",
    "  async save(): Promise<number> {",
    "    return this.clock.now();",
    "  }",
    "",
    "  @Traced({ detail: true })",
    "  async find(): Promise<void> {}",
    "",
    "  @Bare()",
    "  async idle(): Promise<void> {}",
    "}",
  ].join("\n"),
};

describe("weaving table", () => {
  test("flattens stacked markers into one deduplicated, phase-ordered chain", async () => {
    const result = await compileSourcesOrThrow(wovenSources);

    expect(JSON.parse(generatedContent(result, "weaving.json"))).toEqual({
      schemaVersion: 1,
      beans: [
        {
          beanId: "src/service.ts#Repo",
          methods: [
            {
              method: "find",
              markers: { traced: { detail: true } },
              chain: [
                {
                  beanId: "src/interceptors.ts#TraceInterceptor",
                  phase: "observability",
                  order: 0,
                  marker: "traced",
                },
              ],
            },
            {
              // 打了标记但无拦截器绑定：不织 wrapper，仍进表（空链可审，#202 定案 4）。
              method: "idle",
              markers: { bare: null },
              chain: [],
            },
            {
              method: "save",
              // 0 参标记记 null（JSON 无 undefined）。
              markers: { audited: { label: "save" }, traced: null },
              chain: [
                {
                  beanId: "src/interceptors.ts#TraceInterceptor",
                  phase: "observability",
                  order: 0,
                  marker: "traced",
                },
                {
                  beanId: "src/interceptors.ts#CacheInterceptor",
                  phase: "cache",
                  order: 0,
                  marker: "audited",
                },
                {
                  beanId: "src/interceptors.ts#EarlyAuditInterceptor",
                  phase: "application",
                  order: -1,
                  marker: "audited",
                },
                {
                  beanId: "src/interceptors.ts#AuditInterceptor",
                  phase: "application",
                  order: 1,
                  marker: "audited",
                },
              ],
            },
          ],
        },
      ],
    });
  });

  test("appends interceptor dependency edges after user parameters in the manifest", async () => {
    const result = await compileSourcesOrThrow(wovenSources);

    const manifest = JSON.parse(generatedContent(result, "manifest.json"));
    const repo = manifest.beans.find(
      (bean: { readonly id: string }) => bean.id === "src/service.ts#Repo",
    );
    expect(repo.dependencies).toEqual([
      {
        parameterIndex: 0,
        targetId: "src/clock.ts#Clock",
        mode: "eager",
        source: expect.anything(),
      },
      // 追加边按拦截器 beanId 排序、parameterIndex 从用户参数后顺延（#202 定案 5）。
      {
        parameterIndex: 1,
        targetId: "src/interceptors.ts#AuditInterceptor",
        mode: "eager",
        source: expect.anything(),
      },
      {
        parameterIndex: 2,
        targetId: "src/interceptors.ts#CacheInterceptor",
        mode: "eager",
        source: expect.anything(),
      },
      {
        parameterIndex: 3,
        targetId: "src/interceptors.ts#EarlyAuditInterceptor",
        mode: "eager",
        source: expect.anything(),
      },
      {
        parameterIndex: 4,
        targetId: "src/interceptors.ts#TraceInterceptor",
        mode: "eager",
        source: expect.anything(),
      },
    ]);
  });

  test("emits an empty table without markers", async () => {
    const result = await compileSourcesOrThrow({
      "service.ts": [
        'import { Injectable } from "@reforce/core";',
        "@Injectable()",
        "export class Plain {}",
      ].join("\n"),
    });

    expect(JSON.parse(generatedContent(result, "weaving.json"))).toEqual({
      schemaVersion: 1,
      beans: [],
    });
  });

  test("compiles byte-for-byte identically across two runs", async () => {
    const first = await compileSourcesOrThrow(wovenSources);
    const second = await compileSourcesOrThrow(wovenSources);

    expect(generatedContent(first, "weaving.json")).toBe(generatedContent(second, "weaving.json"));
    expect(generatedContent(first, "beans.ts")).toBe(generatedContent(second, "beans.ts"));
  });
});
