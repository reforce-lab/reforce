import {
  createTemporaryProject,
  type ProjectTree,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterAll, describe, expect, test } from "vitest";
import { type CompileResult, createCompiler } from "@/index";
import { parseSource } from "@/parser/parse-source";
import type { CanonicalFileId } from "@/parser/source-location";
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

async function compileTreeSuccessfully(tree: ProjectTree) {
  const result = await compileTree(tree);
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

function compileApplication(sources: Readonly<Record<string, string>>) {
  return compileTreeSuccessfully({
    "tsconfig.json": applicationTsconfig(),
    src: { "logger-factory.ts": loggerFactorySource, ...sources },
  });
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
      .filter((id: string) => id.startsWith("@reforce/logging#Logger("));
    expect(loggerIds).toEqual([
      "@reforce/logging#Logger(OrderService)",
      "@reforce/logging#Logger(PaymentService)",
    ]);
  }, 60_000);

  // 运行时的 claimClassTarget 要求每条 class registration 的 target 对象互不相同，
  // 两个 logger 共用一个 BoundLogger 会当场 fail。
  test("emits a distinct subclass per logger so the class targets stay unique", async () => {
    const { beans } = await compileApplication(twoConsumers);

    // 三条：两个 logger 各一条，加上级别快照 bean——它同样靠字面量实参构造。
    const subclasses = [...beans.matchAll(/class (beanTarget\d+\$Literal) extends/gu)].map(
      (match) => match[1],
    );
    expect(subclasses).toHaveLength(3);
    expect(new Set(subclasses).size).toBe(3);
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
        .filter((id: string) => id.startsWith("@reforce/logging#Logger(")),
    ).toEqual(["@reforce/logging#Logger(payments)"]);
  }, 60_000);

  // 这条用例的存在理由：本文件其余用例全是对 beans.ts **文本**做匹配，而文本匹配对
  // 「产物根本不是合法 TypeScript」一无所知。首版生成的正是
  // `import { Logger(OrderService) as beanTarget0 } from ...`——每条断言照样绿，产物却连
  // 解析都过不去。bean 身份段与运行导出名在框架 logger 上分家，import 必须用后者。
  test("emits a beans.ts that actually parses", async () => {
    const { beans } = await compileApplication(twoConsumers);

    const parsed = parseSource({
      file: "generated/beans.ts" as CanonicalFileId,
      sourceText: beans,
      sourceKind: "ts",
    });

    expect(parsed.status).toBe("success");
  }, 60_000);

  test("imports the logger runtime export under the bean-identity alias", async () => {
    const { beans } = await compileApplication(twoConsumers);

    expect(beans).toContain('import { BoundLogger as beanTarget0 } from "@reforce/logging');
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

  // A1（RFC 0011 L5，#249）：这一组是「快照真的被人读」那条线的编译期一半。在它们之前，
  // LoggerLevels 是运行期零消费者的——编译期校验拼写、给 did-you-mean，但没有任何代码读
  // 那份名单，用户改了级别不生效。
  test("synthesises one LoggerLevels bean holding the closed name list", async () => {
    const { manifest, beans } = await compileApplication(twoConsumers);

    const levels = manifest.beans.find(
      (bean: { readonly id: string }) => bean.id === "@reforce/logging#LoggerLevels",
    );
    expect(levels).toBeDefined();
    expect(beans).toContain('"names":["OrderService","PaymentService"]');
  }, 60_000);

  test("inlines the level a .env layer sets for a named logger", async () => {
    const { beans } = await compileTreeSuccessfully({
      "tsconfig.json": applicationTsconfig(),
      ".env": "LOGGING_LEVEL_ORDERSERVICE=debug\n",
      src: { "logger-factory.ts": loggerFactorySource, ...twoConsumers },
    });

    expect(beans).toContain('"levels":{"OrderService":"debug"}');
  }, 60_000);

  // `.env` 里写了不是级别的值时，把它原样内联等于让运行期拿到一个非 LogLevel 的字符串——
  // 落进 pino 会当场抛。丢掉它、落回绑定缺省，与运行期 parseLogLevel 遇到坏值时一致。
  test("drops a .env value that does not name a level", async () => {
    const { beans } = await compileTreeSuccessfully({
      "tsconfig.json": applicationTsconfig(),
      ".env": "LOGGING_LEVEL_ORDERSERVICE=verbose\n",
      src: { "logger-factory.ts": loggerFactorySource, ...twoConsumers },
    });

    expect(beans).toContain('"levels":{}');
  }, 60_000);

  // 快照带上编译期实际读过的层，启动时才比得出 REFORCE_PROFILE 偏斜（L5 表第三行）。
  test("records the env layers it actually read", async () => {
    const { beans } = await compileTreeSuccessfully({
      "tsconfig.json": applicationTsconfig(),
      ".env": "LOGGING_LEVEL_ORDERSERVICE=debug\n",
      src: { "logger-factory.ts": loggerFactorySource, ...twoConsumers },
    });

    expect(beans).toContain('"layers":[".env"]');
  }, 60_000);

  // 快照 bean 与 logger bean 同属那条解析特例：provides 为空，不进候选池。进了的话，注入
  // LoggerLevels 的绑定会和它自己撞成 AMBIGUOUS_BEAN。
  test("keeps the LoggerLevels bean out of the contract candidate pool", async () => {
    const { manifest } = await compileApplication(twoConsumers);

    const levels = manifest.beans.find(
      (bean: { readonly id: string }) => bean.id === "@reforce/logging#LoggerLevels",
    );
    expect(levels.provides).toEqual([]);
    expect(levels.dependencies).toEqual([]);
  }, 60_000);

  // 用户自写的绑定注入 LoggerLevels 时，那条边必须指到合成的快照 bean 上——这是「改级别
  // 生效」在编译期的最后一环。
  test("points a binding's LoggerLevels parameter at the synthesised bean", async () => {
    const { manifest } = await compileTreeSuccessfully({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "logger-factory.ts": [
          'import { Injectable } from "@reforce/context";',
          'import { DefaultLoggerFactory, LoggerLevels } from "@reforce/logging";',
          'import type { Logger, LoggerFactory } from "@reforce/logging";',
          "",
          "@Injectable()",
          "export class TestLoggerFactory implements LoggerFactory {",
          "  private readonly delegate: DefaultLoggerFactory;",
          "  constructor(levels: LoggerLevels) {",
          "    this.delegate = new DefaultLoggerFactory({ levels });",
          "  }",
          "  create(name: string): Logger {",
          "    return this.delegate.create(name);",
          "  }",
          "}",
          "",
        ].join("\n"),
        ...twoConsumers,
      },
    });

    const factory = manifest.beans.find((bean: { readonly id: string }) =>
      bean.id.endsWith("#TestLoggerFactory"),
    );
    expect(factory.dependencies).toEqual([
      {
        parameterIndex: 0,
        targetId: "@reforce/logging#LoggerLevels",
        mode: "eager",
        source: expect.anything(),
      },
    ]);
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
