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
import {
  nodeModulesTree,
  starterHandleDeclaration,
  starterHandleRuntime,
  starterMetaSpan,
  starterPackage,
} from "./support/starters";

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
    bootstrap: result.files.find((file) => file.path === "bootstrap.ts")?.content ?? "",
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
    'import { Injectable } from "@reforce/core";',
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
    // reforce.core 恒在：容器面的运行期框架输出（摘要、台账、关停、崩溃）归它，装没装
    // 引擎都要有（RFC 0011 L6【已定】）。
    expect(loggerIds).toEqual([
      "@reforce/logging#Logger(OrderService)",
      "@reforce/logging#Logger(PaymentService)",
      "@reforce/logging#Logger(reforce.core)",
    ]);
  }, 60_000);

  // 运行时的 claimClassTarget 要求每条 class registration 的 target 对象互不相同，
  // 两个 logger 共用一个 BoundLogger 会当场 fail。
  test("emits a distinct subclass per logger so the class targets stay unique", async () => {
    const { beans } = await compileApplication(twoConsumers);

    // 四条：两个用户 logger、框架的 reforce.core，加上级别快照 bean——它同样靠字面量
    // 实参构造。
    const subclasses = [...beans.matchAll(/class (beanTarget\d+\$Literal) extends/gu)].map(
      (match) => match[1],
    );
    expect(subclasses).toHaveLength(4);
    expect(new Set(subclasses).size).toBe(4);
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
        'import { Injectable } from "@reforce/core";',
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
    ).toEqual(["@reforce/logging#Logger(payments)", "@reforce/logging#Logger(reforce.core)"]);
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

  // A1（RFC 0011 L5 勘误，#242）：快照收缩为封闭名单——级别的真相在 LoggingSettings bean
  // 里，这份名单供启动期对 settings.levels 的键做确定性 did-you-mean。
  test("synthesises one LoggerLevels bean holding the closed name list", async () => {
    const { manifest, beans } = await compileApplication(twoConsumers);

    const levels = manifest.beans.find(
      (bean: { readonly id: string }) => bean.id === "@reforce/logging#LoggerLevels",
    );
    expect(levels).toBeDefined();
    // reforce.config 在名单里但不是 bean：引导期 logger 由 bootstrapLogger 直接造，收进
    // 名单只是为了让 settings.levels 写 "reforce.config" 不被当成拼错（RFC 0011 C4，#250）。
    expect(beans).toContain(
      '"names":["OrderService","PaymentService","reforce.config","reforce.core"]',
    );
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
          'import { Injectable } from "@reforce/core";',
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

  // A2（RFC 0011 L7，#250）：引导期缓冲此前是零调用的——@reforce/config 的绑定警告只能以
  // 进程退出时的裸 stderr 形态出现，进不了用户配置的日志格式与目标。
  test("exports the LoggerFactory bean so the bootstrap can replay into it", async () => {
    const { beans } = await compileApplication(twoConsumers);

    expect(beans).toMatch(/export \{ [^}]*as loggerFactory \};/u);
  }, 60_000);

  test("replays the bootstrap buffer once the container is up", async () => {
    const { bootstrap } = await compileApplication(twoConsumers);

    expect(bootstrap).toContain("replayBootstrapLogs(application.get(loggerFactory));");
  }, 60_000);

  // 不变量 9：日志系统自身故障必须最吵。绑定构造失败时缓冲是唯一的现场，只靠 exit 兜底会让
  // 它排在调用方自己的错误输出之后，把因果顺序颠倒过来。
  test("drains the bootstrap buffer when the container fails to start", async () => {
    const { bootstrap } = await compileApplication(twoConsumers);

    expect(bootstrap).toContain("drainBootstrapLogs();");
    expect(bootstrap).toContain("throw error;");
  }, 60_000);

  // RFC #242 L6【已定】的两命名空间划分：容器面 reforce.core（原词汇 reforce.context，随主包
  // 更名对齐）、web 面 reforce.web。
  // 此前只合成了后者，于是 job / CLI / worker 这类没有引擎的应用一条都拿不到——没有启动
  // 摘要、没有 bean 台账，崩溃与关停也接不上（那两条要 bootstrap 交出 frameworkLogging）。
  // 这一组用的 compileApplication 正是「有 LoggerFactory、无引擎」那个形状。
  test("hands a non-web application the same container-side logging seam", async () => {
    const { bootstrap } = await compileApplication(twoConsumers);

    expect(bootstrap).toContain("export function frameworkLogging() {");
  }, 60_000);

  test("emits the per-bean timing stream for a non-web application", async () => {
    const { bootstrap } = await compileApplication(twoConsumers);

    expect(bootstrap).toContain(
      "emitBeanTimings({ logger: contextLog, timings: startReport.beanTimings });",
    );
  }, 60_000);

  test("emits a startup summary for a non-web application", async () => {
    const { bootstrap } = await compileApplication(twoConsumers);

    expect(bootstrap).toContain(
      '...contextStartupSections({ beanCount, contextMs }, "reforce.core"),',
    );
  }, 60_000);

  // 摘要里不能有 web 的段落：那个包根本没装。
  test("keeps web sections out of a non-web startup summary", async () => {
    const { bootstrap } = await compileApplication(twoConsumers);

    expect(bootstrap).not.toContain("webStartupSections");
    expect(bootstrap).not.toContain("@reforce/web-core");
  }, 60_000);

  test("reports a missing LoggerFactory as an ordinary compile error", async () => {
    const result = await compileTree({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "application.ts": [
          'import { Injectable } from "@reforce/core";',
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

  // 修法不是「写一个 LoggerFactory」而是注册 starter（RFC 0011 L3 勘误，#242）：这条 help
  // 是用户从「注入了 Logger 却装不上」走出来的唯一路标。
  test("points a missing LoggerFactory at the logging starter in its help", async () => {
    const result = await compileTree({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "application.ts": [
          'import { Injectable } from "@reforce/core";',
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
    const missing = result.diagnostics.find((item) => item.code === "MISSING_BEAN");
    expect(missing?.help).toContain("Register the logging starter from @reforce/logging");
  }, 60_000);

  // —— logging 升格 starter（RFC 0011 勘误，#242）：默认绑定以 defaultBean 随 starter 进图 ——

  // 场景 (c) 的竞争绑定：一个非 default 的 LoggerFactory starter，形状照 pino。
  const fancyBindingPackage = starterPackage({
    name: "@acme/fancy-logging",
    meta: {
      schemaVersion: 1,
      starterDeps: [],
      symbols: [
        {
          id: "@acme/fancy-logging#FancyLoggerFactory",
          file: "dist/index.d.ts",
          subpaths: ["."],
        },
      ],
      beans: [
        {
          id: "@acme/fancy-logging#FancyLoggerFactory",
          runtimeExport: { module: "@acme/fancy-logging", export: "FancyLoggerFactory" },
          provides: [
            "@acme/fancy-logging#FancyLoggerFactory",
            "@reforce/logging-contracts:dist/contracts.d.ts#LoggerFactory",
          ],
          dependencies: [],
          source: starterMetaSpan("src/factory.ts"),
        },
      ],
    },
    dist: {
      "index.d.ts": [
        'import type { Logger, LoggerFactory } from "@reforce/logging";',
        "export declare class FancyLoggerFactory implements LoggerFactory {",
        "  create(name: string): Logger;",
        "}",
        starterHandleDeclaration("fancyLogging"),
        "",
      ].join("\n"),
      "index.js": [
        "export class FancyLoggerFactory {",
        "  create() {",
        "    return {",
        "      isEnabled: () => false,",
        "      trace() {},",
        "      debug() {},",
        "      info() {},",
        "      warn() {},",
        "      error() {},",
        "      fatal() {},",
        "    };",
        "  }",
        "}",
        starterHandleRuntime("fancyLogging"),
        "",
      ].join("\n"),
    },
  });

  function loggingStarterApplication(input: {
    readonly extraImports?: readonly string[];
    readonly starters?: string;
    readonly extraSource?: readonly string[];
  }): Readonly<Record<string, string>> {
    return {
      "application.ts": [
        'import { defineApplication, Injectable } from "@reforce/core";',
        'import { logging, type Logger } from "@reforce/logging";',
        ...(input.extraImports ?? []),
        "",
        "@Injectable()",
        "export class OrderService {",
        "  constructor(private readonly log: Logger) {}",
        "}",
        "",
        ...(input.extraSource ?? []),
        `export default defineApplication({ starters: [${input.starters ?? "logging"}] });`,
        "",
      ].join("\n"),
    };
  }

  // 场景 (a)：只注册 logging——默认 settings 与默认 factory 两个 defaultBean 物化，零诊断。
  test("materialises the default binding when only the logging starter is registered", async () => {
    const { manifest, diagnostics } = await compileTreeSuccessfully({
      "tsconfig.json": applicationTsconfig(),
      src: loggingStarterApplication({}),
    });

    const ids = manifest.beans.map((bean: { readonly id: string }) => bean.id);
    expect(ids).toContain("@reforce/logging#DefaultLoggingFactory");
    expect(ids).toContain("@reforce/logging#DefaultLoggingSettings");
    expect(diagnostics).toEqual([]);
  }, 60_000);

  // manifest 里的路径必须与机器无关（#369）：合成的框架 logger 的「它为什么在图里」指向那条
  // starter 绑定，而 starter 装在 node_modules 里。诊断渲染要的是项目根相对路径（能读出代码
  // 框），产物要的是包内相对路径（两台机器上逐字节相同）——两者混用会让 manifest 里出现
  // `../../home/<用户名>/...`，被 CLI 的 portable-path 校验整片拒绝，报成 GENERATED_TRANSACTION_FAILED。
  test("keeps every manifest source path machine-independent when the binding comes from a starter", async () => {
    const { manifest } = await compileTreeSuccessfully({
      "tsconfig.json": applicationTsconfig(),
      src: loggingStarterApplication({}),
    });

    const paths = manifest.beans.flatMap(
      (bean: {
        readonly source: { readonly file: string };
        readonly dependencies: readonly { readonly source: { readonly file: string } }[];
      }) => [bean.source.file, ...bean.dependencies.map((dependency) => dependency.source.file)],
    );

    expect(
      paths.filter((file: string) => file.startsWith("/") || file.split("/").includes("..")),
    ).toEqual([]);
  }, 60_000);

  // 场景 (b)：本地 LoggingSettings bean 恒胜（决策 11）——starter 自带的默认 settings 让位，
  // factory 的 settings 边指到用户 bean 上。零新机制，正是 defaultBean settings 模式的意义。
  test("lets a local LoggingSettings bean displace the starter default", async () => {
    const { manifest } = await compileTreeSuccessfully({
      "tsconfig.json": applicationTsconfig(),
      src: loggingStarterApplication({
        extraImports: ['import type { LoggingSettings } from "@reforce/logging";'],
        extraSource: [
          "@Injectable()",
          "export class AppLogging implements LoggingSettings {",
          '  readonly defaultLevel = "debug" as const;',
          "}",
          "",
        ],
      }),
    });

    const ids = manifest.beans.map((bean: { readonly id: string }) => bean.id);
    expect(ids).not.toContain("@reforce/logging#DefaultLoggingSettings");
    const factory = manifest.beans.find(
      (bean: { readonly id: string }) => bean.id === "@reforce/logging#DefaultLoggingFactory",
    );
    expect(factory.dependencies).toContainEqual(
      expect.objectContaining({ parameterIndex: 0, targetId: "src/application.ts#AppLogging" }),
    );
  }, 60_000);

  // 场景 (c)：非 default 绑定在图 → 默认绑定子图整体不物化（决策 12 的让位），
  // logger bean 的 factory 边指向竞争绑定。
  test("stands the default binding aside when a non-default binding starter is registered", async () => {
    const { manifest } = await compileTreeSuccessfully({
      "tsconfig.json": applicationTsconfig(),
      node_modules: nodeModulesTree({ "@acme/fancy-logging": fancyBindingPackage }),
      src: loggingStarterApplication({
        extraImports: ['import { fancyLogging } from "@acme/fancy-logging";'],
        starters: "logging, fancyLogging",
      }),
    });

    const ids = manifest.beans.map((bean: { readonly id: string }) => bean.id);
    expect(ids).toContain("@acme/fancy-logging#FancyLoggerFactory");
    expect(ids).not.toContain("@reforce/logging#DefaultLoggingFactory");
    expect(ids).not.toContain("@reforce/logging#DefaultLoggingSettings");
    const logger = manifest.beans.find(
      (bean: { readonly id: string }) => bean.id === "@reforce/logging#Logger(OrderService)",
    );
    expect(logger.dependencies[0].targetId).toBe("@acme/fancy-logging#FancyLoggerFactory");
  }, 60_000);

  // 写了 @LoggerName 就是显式意图：非字面量静默落回推导名会让调级与告警规则对着一个
  // 不存在的名字，而编译期的安静让人以为改名生效了。
  test("reports a non-literal @LoggerName as an error instead of falling back", async () => {
    const result = await compileTree({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "logger-factory.ts": loggerFactorySource,
        "application.ts": [
          'export * from "@/logger-factory";',
          'import { Injectable } from "@reforce/core";',
          'import { LoggerName, type Logger } from "@reforce/logging";',
          "",
          'const computed = "pay" + "ments";',
          "",
          "@LoggerName(computed)",
          "@Injectable()",
          "export class PaymentService {",
          "  constructor(private readonly log: Logger) {}",
          "}",
          "",
        ].join("\n"),
      },
    });

    expect(result.status).toBe("failure");
    expect(result.diagnostics.map((item) => item.code)).toContain("INVALID_DECORATOR_USAGE");
  }, 60_000);

  // 模式必须照抄注入点，不能恒 eager：`Lazy<Logger>` 被写成 eager 时 tsc 拦不住——字段拿到
  // 的是 BoundLogger 实例，调 .get() 当场 TypeError（resolve-providers 的注释记着这一条）。
  test("keeps a Lazy<Logger> edge lazy instead of forcing it eager", async () => {
    const { manifest } = await compileApplication({
      "application.ts": [
        'export * from "@/logger-factory";',
        'import { Injectable, type Lazy } from "@reforce/core";',
        'import type { Logger } from "@reforce/logging";',
        "",
        "@Injectable()",
        "export class OrderService {",
        "  constructor(private readonly log: Lazy<Logger>) {}",
        "}",
        "",
      ].join("\n"),
    });

    const consumer = manifest.beans.find((bean: { readonly id: string }) =>
      bean.id.endsWith("#OrderService"),
    );
    expect(consumer.dependencies[0]).toMatchObject({
      targetId: "@reforce/logging#Logger(OrderService)",
      mode: "explicit-lazy",
    });
  }, 60_000);

  test("reports two classes that resolve to one logger name", async () => {
    const result = await compileTree({
      "tsconfig.json": applicationTsconfig(),
      src: {
        "logger-factory.ts": loggerFactorySource,
        "application.ts": [
          'export * from "@/logger-factory";',
          'import { Injectable } from "@reforce/core";',
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
    // 第二消费者的 Logger 边照设重定向：撞名的完整报告就是上面那条，再落一条指向不存在
    // 问题的 MISSING_BEAN 只会把读者引开。
    expect(result.diagnostics.map((item) => item.code)).not.toContain("MISSING_BEAN");
  }, 60_000);
});
