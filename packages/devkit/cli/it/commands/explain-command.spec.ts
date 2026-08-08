import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCompiler } from "@reforce/compiler";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { afterEach, expect, test } from "vitest";
import { runExplainCommand } from "@/commands/explain";
import { runCli } from "@/commands/run-cli";
import { recordingReporter } from "../support/recording-reporter";
import {
  starterApplicationSources,
  starterMeta,
  writeStarterPackage,
} from "../support/starter-fixture";
import { installContextDistribution } from "../support/watch-harness";

// reforce explain 最小版（#148）：manifest 由真实 compiler 编出（含 starter 链接），explain 只读
// 生成物与已安装 meta。IT 覆盖 starter 胜出、本地恒胜让位、名字不命中/歧义与缺 manifest 的失败面。

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

async function createExplainProject(options: {
  readonly sources: Readonly<Record<string, string>>;
  readonly meta?: string;
  readonly compile?: boolean;
}): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    "package.json": `${JSON.stringify({
      name: "explain-application",
      private: true,
      type: "module",
    })}\n`,
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        experimentalDecorators: false,
        emitDecoratorMetadata: false,
      },
      include: ["src", ".reforce/generated/**/*.d.ts"],
    })}\n`,
    src: options.sources,
  });
  projects.push(project);
  await installContextDistribution(project.projectRoot);
  await writeStarterPackage(join(project.projectRoot, "node_modules", "@acme", "starter-redis"), {
    meta: options.meta ?? starterMeta({ defaultBean: true }),
  });
  if (options.compile === false) {
    return project;
  }
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(resolution.diagnostics[0].message);
  }
  const result = await compiler.compile({ project: resolution.project });
  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  const generatedRoot = join(project.projectRoot, ".reforce", "generated");
  await mkdir(generatedRoot, { recursive: true });
  for (const file of result.files) {
    await writeFile(join(generatedRoot, file.path), file.content);
  }
  return project;
}

async function explain(
  project: TemporaryProject,
  beanName: string,
): Promise<{
  readonly exitCode: 0 | 1;
  readonly lines: readonly string[];
  readonly events: ReturnType<typeof recordingReporter>["events"];
}> {
  const output = recordingReporter();
  const lines: string[] = [];
  const exitCode = await runExplainCommand({
    cwd: project.projectRoot,
    projectDirectory: ".",
    beanName,
    reporter: output.reporter,
    writeOutput: (line) => lines.push(line),
  });
  return { exitCode, lines, events: output.events };
}

test("explains a starter bean accepted as the default provider", async () => {
  const project = await createExplainProject({ sources: starterApplicationSources });

  const { exitCode, lines } = await explain(project, "RedisClient");

  expect(exitCode).toBe(0);
  expect(lines[0]).toBe("bean @acme/starter-redis#RedisClient");
  expect(lines).toContain(
    "origin @acme/starter-redis@1.2.0 · registered starter · declared at src/client.ts:1:1 (package-relative)",
  );
  expect(lines.some((line) => line.includes("accepted default provider"))).toBe(true);
});

test("explains a local provider winning while the starter default stands aside", async () => {
  const project = await createExplainProject({
    sources: {
      ...starterApplicationSources,
      "local-cache.ts": [
        'import { Injectable } from "@reforce/core";',
        'import type { Cache } from "@acme/starter-redis";',
        "",
        "@Injectable()",
        "export class LocalCache implements Cache {",
        "  get(key: string): string {",
        '    return "local:" + key;',
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    // 让 starter 至少贡献一个 root bean 保持可见：被完全遮蔽的 starter 在 manifest 中无迹可寻，
    // 是 explain 最小版声明过的盲点（命令 help 与交付说明均已写明）。
    meta: starterMeta({ withRootBean: true, defaultBean: true }),
  });

  const { exitCode, lines } = await explain(project, "LocalCache");

  expect(exitCode).toBe(0);
  expect(
    lines.some((line) =>
      line.startsWith("origin this application · declared at src/local-cache.ts:"),
    ),
  ).toBe(true);
  expect(
    lines.some(
      (line) =>
        line.includes("stood aside @acme/starter-redis#RedisClient") &&
        line.includes("a local provider always wins"),
    ),
  ).toBe(true);
});

test("reports an unknown bean name as a usage error listing known beans", async () => {
  const project = await createExplainProject({ sources: starterApplicationSources });

  const { exitCode, events } = await explain(project, "NoSuchBean");

  expect(exitCode).toBe(1);
  expect(events[0]).toMatchObject({ kind: "failure", command: "explain", code: "CLI_USAGE_ERROR" });
  expect(events[0]).toHaveProperty("message", expect.stringContaining("No bean matches"));
});

test("reports an ambiguous export name listing every match", async () => {
  const project = await createExplainProject({
    sources: {
      "application.ts": starterApplicationSources["application.ts"],
      "consumer.ts": starterApplicationSources["consumer.ts"],
      "one.ts": [
        'import { Injectable } from "@reforce/core";',
        "",
        "@Injectable()",
        "export class Probe {}",
        "",
      ].join("\n"),
      "two.ts": [
        'import { Injectable } from "@reforce/core";',
        "",
        "@Injectable()",
        "export class Probe {}",
        "",
      ].join("\n"),
    },
  });

  const { exitCode, events } = await explain(project, "Probe");

  expect(exitCode).toBe(1);
  expect(events[0]).toMatchObject({ kind: "failure", code: "CLI_USAGE_ERROR" });
  expect(events[0]).toHaveProperty("message", expect.stringContaining("src/one.ts#Probe"));
  expect(events[0]).toHaveProperty("message", expect.stringContaining("src/two.ts#Probe"));
});

test("reports a missing generated manifest with recovery guidance", async () => {
  const project = await createExplainProject({
    sources: starterApplicationSources,
    compile: false,
  });

  const { exitCode, events } = await explain(project, "RedisClient");

  expect(exitCode).toBe(1);
  expect(events[0]).toMatchObject({
    kind: "failure",
    command: "explain",
    code: "ARTIFACT_INVALID",
  });
  expect(events[0]).toHaveProperty(
    "message",
    expect.stringContaining("Run reforce build or reforce dev first."),
  );
});

test("runCli dispatches the explain command", async () => {
  const project = await createExplainProject({ sources: starterApplicationSources });
  const output = recordingReporter();

  const exitCode = await runCli({
    argv: [process.execPath, "reforce", "explain", "RedisClient", "--project", "."],
    cwd: project.projectRoot,
    reporter: output.reporter,
  });

  expect(exitCode).toBe(0);
  expect(output.events.filter((event) => event.kind === "failure")).toEqual([]);
});

// —— web 面（ADR 0006 W1，#153）：路由查询只读 routes.json，静态回答 路径 → 处理链 ——

const webApplicationSources = {
  "web.ts": [
    'import { Injectable } from "@reforce/core";',
    'import { Controller, Get, Middleware, type RequestContext } from "@reforce/web-core";',
    "",
    '@Middleware({ phase: "admission", global: true })',
    "export class Gate {",
    "  handle(context: RequestContext, next: () => Promise<Response>): Promise<Response> {",
    "    return next();",
    "  }",
    "}",
    "",
    '@Controller("/ping")',
    "export class PingController {",
    "  @Get()",
    "  ping(): Response {",
    '    return new Response("pong");',
    "  }",
    "}",
    "",
  ].join("\n"),
};

test("explains a route's handling chain from the generated route table", async () => {
  const project = await createExplainProject({ sources: webApplicationSources });

  const { exitCode, lines } = await explain(project, "GET /ping");

  expect(exitCode).toBe(0);
  expect(lines).toEqual([
    "GET /ping",
    "  handler src/web.ts#PingController · ping()",
    "  middleware chain (outer → inner) · flattened at compile time by (phase, order, beanId)",
    "  1. admission · order 0 · global · src/web.ts#Gate",
    "  response · passthrough (handler-controlled Response; void answers 204)",
  ]);
});

test("a concrete path resolves the parameterless route pattern for every method", async () => {
  const project = await createExplainProject({ sources: webApplicationSources });

  const { exitCode, lines } = await explain(project, "/ping");

  expect(exitCode).toBe(0);
  expect(lines[0]).toBe("GET /ping");
});

test("an unmatched route query lists the known routes", async () => {
  const project = await createExplainProject({ sources: webApplicationSources });

  const { exitCode, events } = await explain(project, "/nowhere");

  expect(exitCode).toBe(1);
  expect(events[0]).toHaveProperty(
    "message",
    expect.stringContaining('No route matches "/nowhere". Known routes: GET /ping'),
  );
});

test("a route query without a generated route table reports recovery guidance", async () => {
  const project = await createExplainProject({
    sources: webApplicationSources,
    compile: false,
  });

  const { exitCode, events } = await explain(project, "/ping");

  expect(exitCode).toBe(1);
  expect(events[0]).toHaveProperty(
    "message",
    expect.stringContaining("Run reforce build or reforce dev first."),
  );
});

// 织入面（ADR 0008 AM2，#204 定案 7）：真实 compiler 编出 weaving.json 与合成注册，explain
// 渲染被织方法的链行与生效语义；框架拦截器 bean 自身同样可解释。
test("explains a transactional bean with its woven chain and effective semantics", async () => {
  const project = await createExplainProject({
    sources: {
      "manager.ts": [
        'import { Injectable } from "@reforce/core";',
        'import type { TransactionManager, TransactionOptions } from "@reforce/transaction";',
        "",
        "@Injectable()",
        "export class SqlManager implements TransactionManager<string> {",
        "  async withTransaction<T>(options: TransactionOptions, fn: (resource: string) => Promise<T>): Promise<T> {",
        '    return await fn("tx");',
        "  }",
        "}",
        "",
      ].join("\n"),
      "orders.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Transactional } from "@reforce/transaction";',
        "",
        "@Injectable()",
        "export class Orders {",
        '  @Transactional({ propagation: "REQUIRES_NEW" })',
        "  async save(): Promise<void> {}",
        "}",
        "",
      ].join("\n"),
    },
  });

  const { exitCode, lines } = await explain(project, "Orders");

  expect(exitCode).toBe(0);
  expect(lines).toContain("woven method save");
  expect(lines).toContain(
    "  marker transactional · effective propagation REQUIRES_NEW · effective isolation database default",
  );
  expect(lines).toContain(
    "  chain [1] @reforce/transaction#TransactionInterceptor · @reforce/transaction · framework · phase transaction · order 0 · via transactional",
  );
});

test("explains the synthesized framework interceptor bean itself", async () => {
  const project = await createExplainProject({
    sources: {
      "manager.ts": [
        'import { Injectable } from "@reforce/core";',
        'import type { TransactionManager, TransactionOptions } from "@reforce/transaction";',
        "",
        "@Injectable()",
        "export class SqlManager implements TransactionManager<string> {",
        "  async withTransaction<T>(options: TransactionOptions, fn: (resource: string) => Promise<T>): Promise<T> {",
        '    return await fn("tx");',
        "  }",
        "}",
        "",
      ].join("\n"),
      "orders.ts": [
        'import { Injectable } from "@reforce/core";',
        'import { Transactional } from "@reforce/transaction";',
        "",
        "@Injectable()",
        "export class Orders {",
        "  @Transactional()",
        "  async save(): Promise<void> {}",
        "}",
        "",
      ].join("\n"),
    },
  });

  const { exitCode, lines } = await explain(project, "TransactionInterceptor");

  expect(exitCode).toBe(0);
  expect(lines[0]).toBe("bean @reforce/transaction#TransactionInterceptor");
  expect(
    lines.some((line) =>
      line.startsWith("origin @reforce/transaction · framework · declared at src/orders.ts:"),
    ),
  ).toBe(true);
  expect(
    lines.some(
      (line) =>
        line.startsWith("dependency [0] -> src/manager.ts#SqlManager") &&
        line.includes("this application · eager"),
    ),
  ).toBe(true);
});

// —— 诊断码长文（RFC 0011 D8，#242）——

test("explains a diagnostic code without reading any generated artifact", async () => {
  const project = await createExplainProject({
    sources: starterApplicationSources,
    compile: false,
  });

  const { exitCode, lines, events } = await explain(project, "MISSING_BEAN");

  expect(exitCode).toBe(0);
  expect(lines[0]).toContain("MISSING_BEAN · ");
  expect(events.filter((event) => event.kind === "failure")).toEqual([]);
});

// 决议 5 收口（#297）：不再存在「已知但无长文」的码——那个状态由 codes.spec 的全量覆盖断言
// 保证为空，这里改为断言此前处于该状态的探针码如今落在长文分支。原探针 TYPE_LINK_FAILED
// （compiler 域）与 REQUEST_CONTEXT_MISSING（core 域）保留，仍然覆盖「跨包码表被识别」。
test("explains a formerly article-less compiler code", async () => {
  const project = await createExplainProject({ sources: starterApplicationSources });

  const { exitCode, lines } = await explain(project, "TYPE_LINK_FAILED");

  expect(exitCode).toBe(0);
  expect(lines[0]).toContain("TYPE_LINK_FAILED · ");
});

test("recognizes a code from another package's table", async () => {
  const project = await createExplainProject({ sources: starterApplicationSources });

  const { exitCode, lines } = await explain(project, "REQUEST_CONTEXT_MISSING");

  expect(exitCode).toBe(0);
  expect(lines[0]).toContain("REQUEST_CONTEXT_MISSING · ");
});

// CLI 失败码住在 @reforce/runtime 的表里（cliFailureCodes），是五张长文表里最后接入的一张；
// 真实 CLI 里必须同样落在长文分支。
test("explains a CLI failure code", async () => {
  const project = await createExplainProject({ sources: starterApplicationSources });

  const { exitCode, lines } = await explain(project, "PROJECT_BUSY");

  expect(exitCode).toBe(0);
  expect(lines[0]).toContain("PROJECT_BUSY · ");
});

// #297 第一批：事务护栏七码。真实 CLI 里这条查询必须落在长文分支，而不是「暂无长文」出口。
test("explains a transaction guard code", async () => {
  const project = await createExplainProject({ sources: starterApplicationSources });

  const { exitCode, lines } = await explain(project, "TRANSACTION_TIMEOUT");

  expect(exitCode).toBe(0);
  expect(lines[0]).toContain("TRANSACTION_TIMEOUT · ");
});

// 拼错的码与真实但无长文的码该说的话完全不同：前者不该附上全部 bean 的清单。
test("separates a misspelt code from a real one", async () => {
  const project = await createExplainProject({ sources: starterApplicationSources });

  const { exitCode, events } = await explain(project, "MISSNG_BEAN");

  expect(exitCode).toBe(1);
  expect(events[0]).toHaveProperty(
    "message",
    expect.stringContaining('No error code named "MISSNG_BEAN" exists'),
  );
});

// 决议 3/6 的新码当下就可查：长文与码同 PR（#293 / #295）。
test("explains a framework error code that is not a compiler diagnostic", async () => {
  const project = await createExplainProject({ sources: starterApplicationSources });

  const { exitCode, lines } = await explain(project, "WEB_NOT_FOUND");

  expect(exitCode).toBe(0);
  expect(lines[0]).toContain("WEB_NOT_FOUND · ");
});

// 歧义消解靠「命中长文表」而不是正则猜形状：全大写的契约 displayName 不能被 CODE 分支抢走。
test("keeps an all-caps bean name on the bean branch", async () => {
  const project = await createExplainProject({ sources: starterApplicationSources });

  const { exitCode, lines } = await explain(project, "RedisClient");

  expect(exitCode).toBe(0);
  expect(lines[0]).toBe("bean @acme/starter-redis#RedisClient");
});
