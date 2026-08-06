import {
  createTemporaryProject,
  type ProjectTree,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterAll, describe, expect, test } from "vitest";
import { type CompileResult, createCompiler } from "@/index";
import {
  applicationTsconfig,
  linkApplicationPackages,
  linkLoggingPackage,
} from "./support/project";

// logger bean 合成的端到端（RFC 0011 L2，#242）：真编译一个注入 Logger 的应用，断言生成的
// beans.ts 与 manifest 的形状。单测覆盖不到的正是这里——逐 logger 子类、字面量实参、以及
// manifest 校验肯不肯收这种「一个运行导出承载 N 个 bean 身份」的 bean。

const temporaryProjects: TemporaryProject[] = [];

afterAll(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

// 一个最小的 LoggerFactory 绑定：logger bean 对 LoggerFactory 的边走正常解析，图里没有
// 实现就是 MISSING_BEAN，所以每个正向用例都要有它。
const loggerFactorySource = [
  'import { Injectable } from "@reforce/context";',
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
  "",
].join("\n");

async function compileTree(tree: ProjectTree): Promise<CompileResult> {
  const project = await createTemporaryProject(tree);
  temporaryProjects.push(project);
  await linkApplicationPackages(project.projectRoot);
  await linkLoggingPackage(project.projectRoot);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  return await compiler.compile({ project: resolution.project });
}

async function compileApplication(sources: Readonly<Record<string, string>>) {
  const result = await compileTree({
    "tsconfig.json": applicationTsconfig(),
    src: { "logger-factory.ts": loggerFactorySource, ...sources },
  });
  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics, undefined, 2));
  }
  return {
    beans: result.files.find((file) => file.path === "beans.ts")?.content ?? "",
    manifest: JSON.parse(
      result.files.find((file) => file.path === "manifest.json")?.content ?? "{}",
    ),
    diagnostics: result.diagnostics,
  };
}

const twoConsumers = {
  "application.ts": [
    'export * from "@/logger-factory";',
    'import { Injectable } from "@reforce/context";',
    'import type { Logger } from "@reforce/logging";',
    "",
    "@Injectable()",
    "export class OrderService {",
    "  constructor(private readonly log: Logger) {}",
    "}",
    "",
    "@Injectable()",
    "export class PaymentService {",
    "  constructor(private readonly log: Logger) {}",
    "}",
    "",
  ].join("\n"),
};

describe("synthesised logger beans", () => {
  test("gives each consumer its own logger bean named after the consumer", async () => {
    const { manifest } = await compileApplication(twoConsumers);

    const loggerIds = manifest.beans
      .map((bean: { readonly id: string }) => bean.id)
      .filter((id: string) => id.startsWith("@reforce/logging#"));
    expect(loggerIds).toEqual([
      "@reforce/logging#Logger(OrderService)",
      "@reforce/logging#Logger(PaymentService)",
    ]);
  }, 60_000);

  // 运行时的 claimClassTarget 要求每条 class registration 的 target 对象互不相同，
  // 两个 logger 共用一个 BoundLogger 会当场 fail。
  test("emits a distinct subclass per logger so the class targets stay unique", async () => {
    const { beans } = await compileApplication(twoConsumers);

    const subclasses = [...beans.matchAll(/class (beanTarget\d+\$Literal) extends/gu)].map(
      (match) => match[1],
    );
    expect(subclasses).toHaveLength(2);
    expect(new Set(subclasses).size).toBe(2);
  }, 60_000);

  test("inlines the logger name as a literal constructor argument", async () => {
    const { beans } = await compileApplication(twoConsumers);

    expect(beans).toContain('"OrderService")');
    expect(beans).toContain('"PaymentService")');
  }, 60_000);

  // 字面量实参只进编译器模型：runtimeDependencies() 里必须只剩 LoggerFactory 那一条边。
  test("keeps the literal argument out of the runtime dependency list", async () => {
    const { manifest } = await compileApplication(twoConsumers);

    const logger = manifest.beans.find(
      (bean: { readonly id: string }) => bean.id === "@reforce/logging#Logger(OrderService)",
    );
    expect(logger.dependencies).toHaveLength(1);
    expect(logger.dependencies[0].parameterIndex).toBe(0);
  }, 60_000);

  test("lets @LoggerName override the derived name", async () => {
    const { manifest } = await compileApplication({
      "application.ts": [
        'export * from "@/logger-factory";',
        'import { Injectable } from "@reforce/context";',
        'import { LoggerName, type Logger } from "@reforce/logging";',
        "",
        '@LoggerName("payments")',
        "@Injectable()",
        "export class PaymentService {",
        "  constructor(private readonly log: Logger) {}",
        "}",
        "",
      ].join("\n"),
    });

    expect(
      manifest.beans
        .map((bean: { readonly id: string }) => bean.id)
        .filter((id: string) => id.startsWith("@reforce/logging#")),
    ).toEqual(["@reforce/logging#Logger(payments)"]);
  }, 60_000);

  // logger bean 不提供任何契约，所以它绝不能参与按类型选择——否则每条 Logger 边都
  // AMBIGUOUS_BEAN。
  test("keeps logger beans out of the contract candidate pool", async () => {
    const { manifest } = await compileApplication(twoConsumers);

    const logger = manifest.beans.find(
      (bean: { readonly id: string }) => bean.id === "@reforce/logging#Logger(OrderService)",
    );
    expect(logger.provides).toEqual([]);
  }, 60_000);

  test("reports a missing LoggerFactory as an ordinary compile error", async () => {
    const result = await compileTree({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "application.ts": [
          'import { Injectable } from "@reforce/context";',
          'import type { Logger } from "@reforce/logging";',
          "",
          "@Injectable()",
          "export class OrderService {",
          "  constructor(private readonly log: Logger) {}",
          "}",
          "",
        ].join("\n"),
      },
    });

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("MISSING_BEAN");
  }, 60_000);

  test("reports two classes that resolve to one logger name", async () => {
    const result = await compileTree({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "logger-factory.ts": loggerFactorySource,
        "application.ts": [
          'export * from "@/logger-factory";',
          'import { Injectable } from "@reforce/context";',
          'import { LoggerName, type Logger } from "@reforce/logging";',
          "",
          '@LoggerName("shared")',
          "@Injectable()",
          "export class OrderService {",
          "  constructor(private readonly log: Logger) {}",
          "}",
          "",
          '@LoggerName("shared")',
          "@Injectable()",
          "export class PaymentService {",
          "  constructor(private readonly log: Logger) {}",
          "}",
          "",
        ].join("\n"),
      },
    });

    expect(result.status).toBe("failure");
    const duplicate = result.diagnostics.find((item) => item.code === "DUPLICATE_LOGGER_NAME");
    expect(duplicate).toBeDefined();
    // 双侧定位：读者要能同时看到抢同一个名字的两个类。
    expect(duplicate?.related).toHaveLength(2);
  }, 60_000);
});
