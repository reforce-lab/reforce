import {
  createTemporaryProject,
  type ProjectTree,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterAll, describe, expect, test } from "vitest";
import { createCompiler } from "@/index";
import {
  applicationTsconfig,
  linkApplicationPackages,
  linkLoggingPackage,
} from "./support/project";

// 风险 1 的实测（RFC 0011「风险」第 1 条，#242）：「bean 数量随注入 Logger 的类数线性增长：
// constructionOrder、manifest、生成物体积都随之变长。**需要在真实规模的 fixture 上量出数字，
// 不靠估计**。」
//
// 写成用例而不是量一次记在注释里：注释里的数字第一次重构就过期，而且没人会发现它过期了。
// 这条把「线性」和「每条 logger 的边际成本」变成持续成立的断言——真做了什么让边际成本
// 变成超线性，或者让一条 logger 贵出一个量级，它当场红。

const temporaryProjects: TemporaryProject[] = [];

afterAll(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

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

// 两组的**类数完全相同**，只有注入不注入 Logger 的差别——否则量到的是「多写了几个类」的
// 成本，不是 logger bean 的成本。
function servicesSource(count: number, injectsLogger: boolean): string {
  const lines = [
    'export * from "@/logger-factory";',
    'import { Injectable } from "@reforce/context";',
    ...(injectsLogger ? ['import type { Logger } from "@reforce/logging";'] : []),
    "",
  ];
  for (let index = 0; index < count; index += 1) {
    lines.push(
      "@Injectable()",
      `export class Service${index} {`,
      ...(injectsLogger ? ["  constructor(private readonly log: Logger) {}"] : []),
      "}",
      "",
    );
  }
  return lines.join("\n");
}

interface Artifacts {
  readonly beanCount: number;
  readonly loggerBeanCount: number;
  readonly manifestBytes: number;
  readonly beansBytes: number;
  readonly constructionOrderLength: number;
}

async function compileServices(count: number, injectsLogger: boolean): Promise<Artifacts> {
  const tree: ProjectTree = {
    "tsconfig.json": applicationTsconfig(),
    src: {
      "logger-factory.ts": loggerFactorySource,
      "application.ts": servicesSource(count, injectsLogger),
    },
  };
  const project = await createTemporaryProject(tree);
  temporaryProjects.push(project);
  await linkApplicationPackages(project.projectRoot);
  await linkLoggingPackage(project.projectRoot);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  const result = await compiler.compile({ project: resolution.project });
  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics, undefined, 2));
  }
  const manifestText = result.files.find((file) => file.path === "manifest.json")?.content ?? "{}";
  const beansText = result.files.find((file) => file.path === "beans.ts")?.content ?? "";
  const manifest: unknown = JSON.parse(manifestText);
  const beans: readonly { readonly id: string }[] =
    typeof manifest === "object" && manifest !== null
      ? ((Reflect.get(manifest, "beans") ?? []) as readonly { readonly id: string }[])
      : [];
  const plans =
    typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "plans") : undefined;
  const constructionOrder =
    typeof plans === "object" && plans !== null ? Reflect.get(plans, "constructionOrder") : [];
  return {
    beanCount: beans.length,
    loggerBeanCount: beans.filter((bean) => bean.id.startsWith("@reforce/logging#Logger(")).length,
    manifestBytes: Buffer.byteLength(manifestText, "utf8"),
    beansBytes: Buffer.byteLength(beansText, "utf8"),
    constructionOrderLength: Array.isArray(constructionOrder) ? constructionOrder.length : 0,
  };
}

describe("the cost of a synthesised logger bean", () => {
  test("one logger bean per injecting class, and nothing extra", async () => {
    const withLoggers = await compileServices(12, true);
    const withoutLoggers = await compileServices(12, false);

    // 12 个注入者 + reforce.context 那条框架 logger。缓解措施「只为**实际注入了 Logger 的类**
    // 合成」在这里是可验的：不注入的那一组一条 logger bean 都没有。
    expect(withLoggers.loggerBeanCount).toBe(13);
    // 不注入的那一组只剩 reforce.context 那一条：缓解措施「只为**实际注入了 Logger 的类**
    // 合成」在这里可验——12 个类一条用户 logger 都没合成。框架那条与用户注入无关，它是
    // L6 的容器面输出，只要图里有绑定就恒在。
    expect(withoutLoggers.loggerBeanCount).toBe(1);
    // 每条 logger bean 都进 constructionOrder，与 bean 表同步增长——它们是普通 singleton，
    // 这正是 L2「运行时侧零新增」的代价面。
    expect(withLoggers.constructionOrderLength - withoutLoggers.constructionOrderLength).toBe(
      withLoggers.beanCount - withoutLoggers.beanCount,
    );
  }, 120_000);

  test("the marginal cost per logger stays flat as the application grows", async () => {
    const small = await compileServices(4, true);
    const large = await compileServices(16, true);

    const addedLoggers = large.loggerBeanCount - small.loggerBeanCount;
    expect(addedLoggers).toBe(12);
    const manifestPerLogger = (large.manifestBytes - small.manifestBytes) / addedLoggers;
    const beansPerLogger = (large.beansBytes - small.beansBytes) / addedLoggers;

    // **本机实测（2026-08-07，Node 26.5.1）：manifest 2995 B/logger、beans.ts 2012 B/logger。**
    // 也就是每个注入 Logger 的类给生成物加约 5 KiB。一个 200 类、半数注入的应用因此多出
    // 约 500 KiB 生成物——RFC 风险 1 说的「不靠估计」，估计出来的数（我先写的是 0.6 KiB）
    // 差了五倍，所以这个数必须是量的。
    //
    // 两者的去向不同，别混着算：manifest 是构建期产物（explain 与校验读它），不进用户的
    // dist；beans.ts 会被打包进去，那 2 KiB 才是终端用户真正付的。
    //
    // 上界留约 1.4 倍余量：够容纳字段增补，拦得住量级变化。
    expect(manifestPerLogger).toBeLessThan(4096);
    expect(beansPerLogger).toBeLessThan(3072);
  }, 120_000);
});
