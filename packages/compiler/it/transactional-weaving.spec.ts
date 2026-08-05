import {
  createTemporaryProject,
  type ProjectTree,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterAll, describe, expect, test } from "vitest";
import { type CompileResult, createCompiler, type GeneratedFile } from "@/index";
import { applicationTsconfig } from "./support/project";

// @Transactional 编译期语义 IT（ADR 0008 AM2，#204 定案 2/6）：框架标记走 AM1 通道、参数
// schema 硬错、保留 key、事务拦截器合成注册与 TransactionManager 契约的编译期整图校验——
// 有使用无实现是 MISSING_BEAN，不是运行时才炸。

type CompileSuccess = Extract<CompileResult, { readonly status: "success" }>;
type FailureResult = Extract<CompileResult, { readonly status: "failure" }>;

const temporaryProjects: TemporaryProject[] = [];

afterAll(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

async function compileSources(sources: Record<string, string>): Promise<CompileResult> {
  const tree: ProjectTree = { "tsconfig.json": applicationTsconfig(), src: sources };
  const project = await createTemporaryProject(tree);
  temporaryProjects.push(project);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  return await compiler.compile({ project: resolution.project });
}

async function compileSourcesOrThrow(sources: Record<string, string>): Promise<CompileSuccess> {
  const result = await compileSources(sources);
  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

function failureCodes(result: CompileResult): readonly string[] {
  expect(result.status).toBe("failure");
  if (result.status !== "failure") {
    throw new Error("Expected a failed compilation");
  }
  return (result satisfies FailureResult).diagnostics.map((item) => item.code);
}

function generatedContent(result: CompileSuccess, filePath: GeneratedFile["path"]): string {
  const content = result.files.find((file) => file.path === filePath)?.content;
  if (content === undefined) {
    throw new Error(`Missing generated file ${filePath}`);
  }
  return content;
}

const managerSource = [
  'import { Injectable } from "@reforce/context";',
  'import type { TransactionManager, TransactionOptions } from "@reforce/context";',
  "",
  "@Injectable()",
  "export class SqlManager implements TransactionManager<string> {",
  "  async withTransaction<T>(options: TransactionOptions, fn: (resource: string) => Promise<T>): Promise<T> {",
  '    return await fn("tx");',
  "  }",
  "}",
].join("\n");

const serviceSource = [
  'import { Injectable, Transactional } from "@reforce/context";',
  "",
  "@Injectable()",
  "export class OrderService {",
  "  @Transactional()",
  "  async save(): Promise<void> {}",
  "",
  '  @Transactional({ propagation: "REQUIRES_NEW", isolation: "SERIALIZABLE" })',
  "  async audit(): Promise<void> {}",
  "}",
].join("\n");

describe("transaction interceptor synthesis", () => {
  test("a @Transactional use synthesizes the framework interceptor registration and weaves the chain", async () => {
    const result = await compileSourcesOrThrow({
      "manager.ts": managerSource,
      "service.ts": serviceSource,
    });

    const weaving = JSON.parse(generatedContent(result, "weaving.json"));
    expect(weaving.beans).toEqual([
      {
        beanId: "src/service.ts#OrderService",
        methods: [
          {
            method: "audit",
            markers: {
              transactional: { propagation: "REQUIRES_NEW", isolation: "SERIALIZABLE" },
            },
            chain: [
              {
                beanId: "@reforce/context#TransactionInterceptor",
                phase: "transaction",
                order: 0,
                marker: "transactional",
              },
            ],
          },
          {
            method: "save",
            markers: { transactional: null },
            chain: [
              {
                beanId: "@reforce/context#TransactionInterceptor",
                phase: "transaction",
                order: 0,
                marker: "transactional",
              },
            ],
          },
        ],
      },
    ]);

    const manifest = JSON.parse(generatedContent(result, "manifest.json"));
    const interceptor = manifest.beans.find(
      (bean: { id: string }) => bean.id === "@reforce/context#TransactionInterceptor",
    );
    expect(interceptor.origin).toBe("@reforce/context");
    expect(interceptor.runtimeExport).toEqual({
      moduleSpecifier: "@reforce/context/generated-runtime",
      exportName: "TransactionInterceptor",
    });
    expect(interceptor.dependencies).toEqual([
      expect.objectContaining({
        parameterIndex: 0,
        targetId: "src/manager.ts#SqlManager",
        mode: "eager",
      }),
    ]);

    const beans = generatedContent(result, "beans.ts");
    expect(beans).toContain('from "@reforce/context/generated-runtime"');
    expect(beans).toContain("TransactionInterceptor as beanTarget");
    expect(beans).toContain("import type { TransactionManager as beanContract");
  });

  test("no synthetic registration exists without a @Transactional use", async () => {
    const result = await compileSourcesOrThrow({ "manager.ts": managerSource });

    const manifest = JSON.parse(generatedContent(result, "manifest.json"));
    const ids = manifest.beans.map((bean: { id: string }) => bean.id);
    expect(ids).not.toContain("@reforce/context#TransactionInterceptor");
  });

  test("a user interceptor bound to Transactional joins the chain in its own phase", async () => {
    const result = await compileSourcesOrThrow({
      "manager.ts": managerSource,
      "service.ts": serviceSource,
      "trace.ts": [
        'import { Injectable, Interceptor, Transactional } from "@reforce/context";',
        'import type { MethodInterceptor, MethodInvocationContext } from "@reforce/context";',
        "",
        "@Injectable()",
        '@Interceptor({ marker: Transactional, phase: "observability" })',
        "export class TransactionTraceInterceptor implements MethodInterceptor {",
        "  async intercept(context: MethodInvocationContext, next: () => Promise<unknown>): Promise<unknown> {",
        "    return await next();",
        "  }",
        "}",
      ].join("\n"),
    });

    const weaving = JSON.parse(generatedContent(result, "weaving.json"));
    const chain = weaving.beans[0].methods
      .find((method: { method: string }) => method.method === "save")
      .chain.map((entry: { beanId: string; phase: string }) => `${entry.phase}:${entry.beanId}`);
    expect(chain).toEqual([
      "observability:src/trace.ts#TransactionTraceInterceptor",
      "transaction:@reforce/context#TransactionInterceptor",
    ]);
  });
});

describe("transaction manager contract resolution", () => {
  test("a @Transactional use without any TransactionManager implementation fails at compile time", async () => {
    const result = await compileSources({ "service.ts": serviceSource });

    expect(failureCodes(result)).toContain("MISSING_BEAN");
  });

  test("two competing TransactionManager implementations are ambiguous", async () => {
    const secondManager = managerSource.replace(/SqlManager/g, "OtherManager");
    const result = await compileSources({
      "manager.ts": managerSource,
      "other-manager.ts": secondManager,
      "service.ts": serviceSource,
    });

    expect(failureCodes(result)).toContain("AMBIGUOUS_BEAN");
  });

  test("a Primary implementation resolves the ambiguity", async () => {
    const primaryManager = managerSource
      .replace(
        'import { Injectable } from "@reforce/context";',
        'import { Injectable, Primary } from "@reforce/context";',
      )
      .replace("@Injectable()", "@Injectable()\n@Primary()")
      .replace(/SqlManager/g, "PrimaryManager");
    const result = await compileSourcesOrThrow({
      "manager.ts": managerSource,
      "primary-manager.ts": primaryManager,
      "service.ts": serviceSource,
    });

    const manifest = JSON.parse(generatedContent(result, "manifest.json"));
    const interceptor = manifest.beans.find(
      (bean: { id: string }) => bean.id === "@reforce/context#TransactionInterceptor",
    );
    expect(interceptor.dependencies[0].targetId).toBe("src/primary-manager.ts#PrimaryManager");
  });
});

describe("transactional value schema (compile-time hard errors)", () => {
  const compileWithValue = (value: string) =>
    compileSources({
      "manager.ts": managerSource,
      "service.ts": [
        'import { Injectable, Transactional } from "@reforce/context";',
        "",
        "@Injectable()",
        "export class OrderService {",
        `  @Transactional(${value})`,
        "  async save(): Promise<void> {}",
        "}",
      ].join("\n"),
    });

  test("rejects an unknown propagation literal", async () => {
    expect(failureCodes(await compileWithValue('{ propagation: "MANDATORY" }'))).toContain(
      "INVALID_TRANSACTIONAL_VALUE",
    );
  });

  test("rejects an unknown isolation literal", async () => {
    expect(failureCodes(await compileWithValue('{ isolation: "SNAPSHOT" }'))).toContain(
      "INVALID_TRANSACTIONAL_VALUE",
    );
  });

  test("rejects unknown option keys", async () => {
    expect(failureCodes(await compileWithValue("{ timeout: 5 }"))).toContain(
      "INVALID_TRANSACTIONAL_VALUE",
    );
  });

  test("rejects a non-object value", async () => {
    expect(failureCodes(await compileWithValue('"REQUIRED"'))).toContain(
      "INVALID_TRANSACTIONAL_VALUE",
    );
  });
});

describe("reserved marker key and misuse", () => {
  test("a user marker cannot claim the reserved transactional key", async () => {
    const result = await compileSources({
      "markers.ts": [
        'import { defineMethodMarker } from "@reforce/context";',
        'export const MyTx = defineMethodMarker("transactional");',
      ].join("\n"),
    });

    expect(failureCodes(result)).toContain("INVALID_METHOD_MARKER");
  });

  test("@Transactional cannot mark a class", async () => {
    const result = await compileSources({
      "manager.ts": managerSource,
      "service.ts": [
        'import { Injectable, Transactional } from "@reforce/context";',
        "",
        "@Injectable()",
        "@Transactional()",
        "export class OrderService {",
        "  async save(): Promise<void> {}",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toContain("INVALID_METHOD_MARKER");
  });

  test("@Transactional inherits the AM1 method-shape matrix: a sync method is rejected", async () => {
    const result = await compileSources({
      "manager.ts": managerSource,
      "service.ts": [
        'import { Injectable, Transactional } from "@reforce/context";',
        "",
        "@Injectable()",
        "export class OrderService {",
        "  @Transactional()",
        "  save(): void {}",
        "}",
      ].join("\n"),
    });

    expect(failureCodes(result)).toContain("INVALID_METHOD_MARKER");
  });
});
