import {
  createTemporaryProject,
  type ProjectTree,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterAll, describe, expect, test } from "vitest";
import { type CompileResult, createCompiler, type GeneratedFile } from "@/index";
import { applicationTsconfig, linkLoggingPackage } from "./support/project";

// @Transactional 编译期语义 IT（ADR 0008 AM2，#204 定案 2/6）：框架标记走 AM1 通道、参数
// schema 硬错、保留 key、事务拦截器合成注册与 TransactionManager 契约的编译期整图校验——
// 有使用无实现是 MISSING_BEAN，不是运行时才炸。

type CompileSuccess = Extract<CompileResult, { readonly status: "success" }>;
type FailureResult = Extract<CompileResult, { readonly status: "failure" }>;

const temporaryProjects: TemporaryProject[] = [];

afterAll(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

async function compileSources(
  sources: Record<string, string>,
  options: { readonly linkLogging?: boolean } = {},
): Promise<CompileResult> {
  const tree: ProjectTree = { "tsconfig.json": applicationTsconfig(), src: sources };
  const project = await createTemporaryProject(tree);
  temporaryProjects.push(project);
  if (options.linkLogging === true) {
    await linkLoggingPackage(project.projectRoot);
  }
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  return await compiler.compile({ project: resolution.project });
}

async function compileSourcesOrThrow(
  sources: Record<string, string>,
  options: { readonly linkLogging?: boolean } = {},
): Promise<CompileSuccess> {
  const result = await compileSources(sources, options);
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
  'import { Injectable } from "@reforce/core";',
  'import { activeResourceFor } from "@reforce/transaction";',
  'import type { TransactionManager, TransactionOptions } from "@reforce/transaction";',
  "",
  "@Injectable()",
  "export class SqlManager implements TransactionManager<string> {",
  "  current(): string {",
  '    return activeResourceFor(this) ?? "pool";',
  "  }",
  "  async withTransaction<T>(options: TransactionOptions, fn: (resource: string) => Promise<T>): Promise<T> {",
  '    return await fn("tx");',
  "  }",
  "}",
].join("\n");

// savepoint 能力表达在契约身份上（ADR 0008 T4 定案）：实现 NestedTransactionManager 的类
// 同时提供两个契约 key，注入裸 TransactionManager 的地方照旧装得上。
const nestedManagerSource = [
  'import { Injectable } from "@reforce/core";',
  'import { activeResourceFor } from "@reforce/transaction";',
  'import type { NestedTransactionManager, TransactionOptions } from "@reforce/transaction";',
  "",
  "@Injectable()",
  "export class SqlManager implements NestedTransactionManager<string> {",
  "  current(): string {",
  '    return activeResourceFor(this) ?? "pool";',
  "  }",
  "  async withTransaction<T>(options: TransactionOptions, fn: (resource: string) => Promise<T>): Promise<T> {",
  '    return await fn("tx");',
  "  }",
  "  async withSavepoint<T>(resource: string, fn: (resource: string) => Promise<T>): Promise<T> {",
  "    return await fn(resource);",
  "  }",
  "}",
].join("\n");

const nestedServiceSource = [
  'import { Injectable } from "@reforce/core";',
  'import { Transactional } from "@reforce/transaction";',
  "",
  "@Injectable()",
  "export class OrderService {",
  '  @Transactional({ propagation: "NESTED" })',
  "  async save(): Promise<void> {}",
  "}",
].join("\n");

const serviceSource = [
  'import { Injectable } from "@reforce/core";',
  'import { Transactional } from "@reforce/transaction";',
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
                beanId: "@reforce/transaction#TransactionInterceptor",
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
                beanId: "@reforce/transaction#TransactionInterceptor",
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
      (bean: { id: string }) => bean.id === "@reforce/transaction#TransactionInterceptor",
    );
    expect(interceptor.origin).toBe("@reforce/transaction");
    expect(interceptor.runtimeExport).toEqual({
      moduleSpecifier: "@reforce/transaction/generated-runtime",
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
    expect(beans).toContain('from "@reforce/transaction/generated-runtime"');
    expect(beans).toContain("TransactionInterceptor as beanTarget");
    expect(beans).toContain("import type { TransactionManager as beanContract");
  });

  test("no synthetic registration exists without a @Transactional use", async () => {
    const result = await compileSourcesOrThrow({ "manager.ts": managerSource });

    const manifest = JSON.parse(generatedContent(result, "manifest.json"));
    const ids = manifest.beans.map((bean: { id: string }) => bean.id);
    expect(ids).not.toContain("@reforce/transaction#TransactionInterceptor");
  });

  test("a user interceptor bound to Transactional joins the chain in its own phase", async () => {
    const result = await compileSourcesOrThrow({
      "manager.ts": managerSource,
      "service.ts": serviceSource,
      "trace.ts": [
        'import { Injectable, Interceptor } from "@reforce/core";',
        'import { Transactional } from "@reforce/transaction";',
        'import type { MethodInterceptor, MethodInvocationContext } from "@reforce/core";',
        "",
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
      "transaction:@reforce/transaction#TransactionInterceptor",
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

  // NESTED 让合成拦截器改按 NestedTransactionManager 契约解析：能力缺失从运行时抛
  // TransactionSavepointUnsupportedError 提前成编译期 MISSING_BEAN。
  test("a NESTED use against a manager without savepoints fails at compile time", async () => {
    const result = await compileSources({
      "manager.ts": managerSource,
      "service.ts": nestedServiceSource,
    });

    expect(failureCodes(result)).toContain("MISSING_BEAN");
  });

  test("a NestedTransactionManager satisfies a NESTED use", async () => {
    const result = await compileSources({
      "manager.ts": nestedManagerSource,
      "service.ts": nestedServiceSource,
    });

    expect(result.status).toBe("success");
  });

  test("a NestedTransactionManager also satisfies a plain TransactionManager injection point", async () => {
    const result = await compileSourcesOrThrow({
      "manager.ts": nestedManagerSource,
      "consumer.ts": [
        'import { Injectable } from "@reforce/core";',
        'import type { TransactionManager } from "@reforce/transaction";',
        "",
        "@Injectable()",
        "export class Reporting {",
        "  constructor(private readonly manager: TransactionManager) {}",
        "}",
      ].join("\n"),
      "service.ts": serviceSource,
    });

    const manifest = JSON.parse(generatedContent(result, "manifest.json"));
    const reporting = manifest.beans.find((bean: { id: string }) => bean.id.endsWith("#Reporting"));
    expect(reporting.dependencies[0].targetId).toBe("src/manager.ts#SqlManager");
  });

  test("a Primary implementation resolves the ambiguity", async () => {
    const primaryManager = managerSource
      .replace(
        'import { Injectable } from "@reforce/core";',
        'import { Injectable, Primary } from "@reforce/core";',
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
      (bean: { id: string }) => bean.id === "@reforce/transaction#TransactionInterceptor",
    );
    expect(interceptor.dependencies[0].targetId).toBe("src/primary-manager.ts#PrimaryManager");
  });
});

describe("transactional value schema (compile-time hard errors)", () => {
  const compileWithValue = (value: string) =>
    compileSources({
      "manager.ts": managerSource,
      "service.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Transactional } from "@reforce/transaction";',
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
    expect(failureCodes(await compileWithValue("{ maxWait: 5 }"))).toContain(
      "INVALID_TRANSACTIONAL_VALUE",
    );
  });

  test("a declared timeout flows into the weaving table with no dedicated machinery", async () => {
    const result = await compileSourcesOrThrow({
      "manager.ts": managerSource,
      "service.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Transactional } from "@reforce/transaction";',
        "",
        "@Injectable()",
        "export class OrderService {",
        "  @Transactional({ timeout: 5000 })",
        "  async save(): Promise<void> {}",
        "}",
      ].join("\n"),
    });

    // 定格 AM1「框架标记走标记通道零特权」的设计价值：timeout 只是 marker value 的一个字段，
    // 织入表与 explain 两侧都是泛型 MethodMetaValue，加这个选项没有改动它们任何一行。
    const weaving = JSON.parse(generatedContent(result, "weaving.json"));
    expect(weaving.beans[0].methods[0].markers.transactional).toEqual({ timeout: 5000 });
  });

  test("rejects a non-positive or fractional timeout", async () => {
    expect(failureCodes(await compileWithValue("{ timeout: 0 }"))).toContain(
      "INVALID_TRANSACTIONAL_VALUE",
    );
    expect(failureCodes(await compileWithValue("{ timeout: 1.5 }"))).toContain(
      "INVALID_TRANSACTIONAL_VALUE",
    );
    expect(failureCodes(await compileWithValue('{ timeout: "5s" }'))).toContain(
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
        'import { defineMethodMarker } from "@reforce/core";',
        'export const MyTx = defineMethodMarker("transactional");',
      ].join("\n"),
    });

    expect(failureCodes(result)).toContain("INVALID_METHOD_MARKER");
  });

  test("@Transactional cannot mark a class", async () => {
    const result = await compileSources({
      "manager.ts": managerSource,
      "service.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Transactional } from "@reforce/transaction";',
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
        'import { Injectable } from "@reforce/core";',
        'import { Transactional } from "@reforce/transaction";',
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

// C5（RFC 0011，#250）：事务此前零日志。拦截器持有这条 logger 边，但只在应用本来就绑了
// LoggerFactory 时才有——否则每个用 @Transactional 的应用都会被迫装 @reforce/logging。
describe("transaction logging edge", () => {
  const loggerFactorySource = [
    'import { Injectable } from "@reforce/core";',
    'import type { Logger, LoggerFactory } from "@reforce/logging";',
    "",
    "@Injectable()",
    "export class TestLoggerFactory implements LoggerFactory {",
    "  create(name: string): Logger {",
    "    return {",
    "      isEnabled: () => true,",
    "      trace() {},",
    "      debug() {},",
    "      info() {},",
    "      warn() {},",
    "      error() {},",
    "      fatal() {},",
    "    };",
    "  }",
    "}",
  ].join("\n");

  const transactionalService = [
    'import { Injectable } from "@reforce/core";',
    'import { Transactional } from "@reforce/transaction";',
    "",
    "@Injectable()",
    "export class OrderService {",
    "  @Transactional()",
    "  async save(): Promise<void> {}",
    "}",
  ].join("\n");

  test("synthesizes a reforce.transaction logger bean when a LoggerFactory is bound", async () => {
    const result = await compileSourcesOrThrow(
      {
        "manager.ts": managerSource,
        "logger-factory.ts": loggerFactorySource,
        "service.ts": transactionalService,
      },
      { linkLogging: true },
    );

    expect(generatedContent(result, "beans.ts")).toContain('"reforce.transaction"');
  });

  test("hands that logger to the interceptor as its second constructor argument", async () => {
    const result = await compileSourcesOrThrow(
      {
        "manager.ts": managerSource,
        "logger-factory.ts": loggerFactorySource,
        "service.ts": transactionalService,
      },
      { linkLogging: true },
    );

    const interceptor = (
      JSON.parse(generatedContent(result, "manifest.json")) as {
        beans: readonly { id: string; dependencies: readonly { parameterIndex: number }[] }[];
      }
    ).beans.find((bean) => bean.id === "@reforce/transaction#TransactionInterceptor");
    expect(interceptor?.dependencies.map((edge) => edge.parameterIndex)).toEqual([0, 1]);
  });

  // 无绑定时无条件追加这条边是致命的：它会给一个从没打算写日志的应用凭空造出一条
  // LoggerFactory 的 MISSING_BEAN。
  test("leaves the interceptor at one dependency when nothing binds a LoggerFactory", async () => {
    const result = await compileSourcesOrThrow({
      "manager.ts": managerSource,
      "service.ts": transactionalService,
    });

    const interceptor = (
      JSON.parse(generatedContent(result, "manifest.json")) as {
        beans: readonly { id: string; dependencies: readonly unknown[] }[];
      }
    ).beans.find((bean) => bean.id === "@reforce/transaction#TransactionInterceptor");
    expect(interceptor?.dependencies).toHaveLength(1);
  });
});
