import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundleEntry,
  createTemporaryProject,
  type ProjectTree,
  resolveNodeExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterEach, describe, expect, test } from "vitest";
import { type CompileResult, createCompiler, type GeneratedFile } from "@/index";
import { type CompileSuccess, linkApplicationPackages, linkConfigPackage } from "./support/project";
import {
  nodeModulesTree,
  starterHandleDeclaration,
  starterHandleRuntime,
  starterMetaSpan,
  starterPackage,
} from "./support/starters";

// ADR 0005（#130）配置绑定的编译器语义 IT（#146）：识别 extends 位置的 ConfigProperties
// 直接调用、prefix 字面量与唯一性、子类形状约束、装饰器/Lazy 组合硬错、括号/条件/中间变量
// 不静默跳过（#54 教训）、starter 开放边由 config class 闭合，以及 v2 生成物形状与确定性。

type FailureResult = Extract<CompileResult, { readonly status: "failure" }>;

const temporaryProjects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

function applicationTree(
  sources: Record<string, string>,
  packages: Record<string, ProjectTree> = {},
): ProjectTree {
  return {
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        paths: { "@/*": ["./src/*"] },
      },
      include: ["src", ".reforce/generated/**/*.ts"],
    })}\n`,
    ...(Object.keys(packages).length > 0 ? { node_modules: nodeModulesTree(packages) } : {}),
    src: sources,
  };
}

async function compile(tree: ProjectTree): Promise<{
  readonly project: TemporaryProject;
  readonly result: CompileResult;
}> {
  const project = await createTemporaryProject(tree);
  temporaryProjects.push(project);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  return {
    project,
    result: await compiler.compile({ project: resolution.project }),
  };
}

async function compileOrThrow(tree: ProjectTree): Promise<CompileSuccess> {
  const { result } = await compile(tree);
  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

function expectFailure(result: CompileResult): FailureResult {
  expect(result.status).toBe("failure");
  if (result.status !== "failure") {
    throw new Error("Expected a failed compilation");
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

interface ManifestConfig {
  readonly id: string;
  readonly prefix: string;
  readonly provides: readonly { readonly name: string }[];
}

interface GeneratedManifest {
  readonly schemaVersion: number;
  readonly configs: readonly ManifestConfig[];
  readonly beans: readonly {
    readonly id: string;
    readonly dependencies: readonly {
      readonly parameterIndex: number;
      readonly targetId: string;
    }[];
  }[];
  readonly plans: { readonly constructionOrder: readonly string[] };
}

function manifestOf(result: CompileSuccess): GeneratedManifest {
  return JSON.parse(generatedContent(result, "manifest.json"));
}

// —— 正向 fixture：ServerConfig + 消费者 ——

const plainSchemaSource = "export const serverSchema = {};\n";

const serverConfigSource = [
  'import { ConfigProperties } from "@reforce/config";',
  'import { serverSchema } from "@/schema";',
  "",
  'export class ServerConfig extends ConfigProperties("server", serverSchema) {}',
  "",
].join("\n");

const consumerSource = [
  'import { Injectable } from "@reforce/core";',
  'import { ServerConfig } from "@/server-config";',
  "",
  "@Injectable()",
  "export class Consumer {",
  "  constructor(readonly config: ServerConfig) {}",
  "}",
  "",
].join("\n");

const serverConfigId = "src/server-config.ts#ServerConfig";
const consumerId = "src/consumer.ts#Consumer";

function positiveSources(): Record<string, string> {
  return {
    "schema.ts": plainSchemaSource,
    "server-config.ts": serverConfigSource,
    "consumer.ts": consumerSource,
  };
}

describe("config recognition and generation", () => {
  test("links a config class as an injectable token and emits the v2 definition", async () => {
    const result = await compileOrThrow(applicationTree(positiveSources()));

    const beans = generatedContent(result, "beans.ts");
    expect(beans).toContain(
      'import { createConfigBinding } from "@reforce/config/generated-runtime";',
    );
    expect(beans).toContain("configBean({");
    expect(beans).toContain(`id: "${serverConfigId}"`);
    expect(beans).toContain("schemaVersion: 6,");
    expect(beans).toContain("configBinding: createConfigBinding(),");

    const manifest = manifestOf(result);
    expect(manifest.schemaVersion).toBe(6);
    expect(manifest.configs.map((config) => config.id)).toEqual([serverConfigId]);
    expect(manifest.configs[0]?.prefix).toBe("server");
    const consumer = manifest.beans.find((bean) => bean.id === consumerId);
    expect(consumer?.dependencies).toEqual([
      expect.objectContaining({ parameterIndex: 0, targetId: serverConfigId }),
    ]);
    expect(manifest.plans.constructionOrder).not.toContain(serverConfigId);
    expect(manifest.plans.constructionOrder).toContain(consumerId);
  });

  test("recognizes an aliased ConfigProperties import", async () => {
    const aliased = [
      'import { ConfigProperties as Bind } from "@reforce/config";',
      'import { serverSchema } from "@/schema";',
      "",
      'export class ServerConfig extends Bind("server", serverSchema) {}',
      "",
    ].join("\n");

    const result = await compileOrThrow(
      applicationTree({
        "schema.ts": plainSchemaSource,
        "server-config.ts": aliased,
        "consumer.ts": consumerSource,
      }),
    );

    expect(manifestOf(result).configs.map((config) => config.id)).toEqual([serverConfigId]);
  });

  test("keeps an application without config classes free of @reforce/config", async () => {
    const result = await compileOrThrow(
      applicationTree({
        "consumer.ts": [
          'import { Injectable } from "@reforce/core";',
          "",
          "@Injectable()",
          "export class Consumer {}",
          "",
        ].join("\n"),
      }),
    );

    const beans = generatedContent(result, "beans.ts");
    expect(beans).not.toContain("@reforce/config");
    expect(beans).toContain("configs: [],");
    expect(beans).not.toContain("configBinding:");
    expect(manifestOf(result).configs).toEqual([]);
  });

  test("emits identical bytes across independent compilers", async () => {
    const tree = applicationTree(positiveSources());
    const first = await compileOrThrow(tree);
    const second = await compileOrThrow(tree);

    expect(first.files).toEqual(second.files);
  });
});

describe("config declaration diagnostics", () => {
  async function expectSingleDiagnostic(
    sources: Record<string, string>,
    code: string,
    messageFragment: string,
  ): Promise<FailureResult> {
    const { result } = await compile(applicationTree(sources));
    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => String(item.code))).toEqual([code]);
    expect(failure.diagnostics[0]?.message).toContain(messageFragment);
    expect(failure.diagnostics[0]?.help).toBeDefined();
    return failure;
  }

  test("rejects a non-literal prefix", async () => {
    await expectSingleDiagnostic(
      {
        "schema.ts": plainSchemaSource,
        "server-config.ts": [
          'import { ConfigProperties } from "@reforce/config";',
          'import { serverSchema } from "@/schema";',
          "",
          'const prefix = "server";',
          "export class ServerConfig extends ConfigProperties(prefix, serverSchema) {}",
          "",
        ].join("\n"),
      },
      "INVALID_CONFIG_PROPERTIES",
      "string literal",
    );
  });

  test("rejects two config classes sharing a prefix and relates the first", async () => {
    const { result } = await compile(
      applicationTree({
        "schema.ts": plainSchemaSource,
        "server-config.ts": serverConfigSource,
        "second-config.ts": [
          'import { ConfigProperties } from "@reforce/config";',
          'import { serverSchema } from "@/schema";',
          "",
          'export class SecondConfig extends ConfigProperties("server", serverSchema) {}',
          "",
        ].join("\n"),
      }),
    );

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["DUPLICATE_CONFIG_PREFIX"]);
    // 双侧定位：诊断落在按 fileId 排序靠后的声明上，related 指向首个声明。
    const payload = JSON.stringify(failure.diagnostics);
    expect(payload).toContain("server-config.ts");
    expect(payload).toContain("second-config.ts");
  });

  test("rejects a parenthesized ConfigProperties call in extends", async () => {
    await expectSingleDiagnostic(
      {
        "schema.ts": plainSchemaSource,
        "server-config.ts": [
          'import { ConfigProperties } from "@reforce/config";',
          'import { serverSchema } from "@/schema";',
          "",
          'export class ServerConfig extends (ConfigProperties("server", serverSchema)) {}',
          "",
        ].join("\n"),
      },
      "INVALID_CONFIG_PROPERTIES",
      "direct",
    );
  });

  test("rejects a conditional extends expression referencing ConfigProperties", async () => {
    await expectSingleDiagnostic(
      {
        "schema.ts": plainSchemaSource,
        "server-config.ts": [
          'import { ConfigProperties } from "@reforce/config";',
          'import { serverSchema } from "@/schema";',
          "",
          "class Fallback {}",
          "const flag = true;",
          "export class ServerConfig extends (flag",
          '  ? ConfigProperties("server", serverSchema)',
          "  : Fallback) {}",
          "",
        ].join("\n"),
      },
      "INVALID_CONFIG_PROPERTIES",
      "direct",
    );
  });

  test("rejects a ConfigProperties result stored in an intermediate variable", async () => {
    await expectSingleDiagnostic(
      {
        "schema.ts": plainSchemaSource,
        "server-config.ts": [
          'import { ConfigProperties } from "@reforce/config";',
          'import { serverSchema } from "@/schema";',
          "",
          'const Base = ConfigProperties("server", serverSchema);',
          "export class ServerConfig extends Base {}",
          "",
        ].join("\n"),
      },
      "INVALID_CONFIG_PROPERTIES",
      "extends",
    );
  });

  test("rejects a bare ConfigProperties reference in extends", async () => {
    await expectSingleDiagnostic(
      {
        "schema.ts": plainSchemaSource,
        "server-config.ts": [
          'import { ConfigProperties } from "@reforce/config";',
          "",
          "export class ServerConfig extends ConfigProperties {}",
          "",
        ].join("\n"),
      },
      "INVALID_CONFIG_PROPERTIES",
      "direct",
    );
  });

  test("rejects a subclass constructor", async () => {
    await expectSingleDiagnostic(
      {
        "schema.ts": plainSchemaSource,
        "server-config.ts": [
          'import { ConfigProperties } from "@reforce/config";',
          'import { serverSchema } from "@/schema";',
          "",
          'export class ServerConfig extends ConfigProperties("server", serverSchema) {',
          "  constructor() {",
          "    super({});",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
      "INVALID_CONFIG_PROPERTIES",
      "constructor",
    );
  });

  test("rejects subclass instance fields", async () => {
    await expectSingleDiagnostic(
      {
        "schema.ts": plainSchemaSource,
        "server-config.ts": [
          'import { ConfigProperties } from "@reforce/config";',
          'import { serverSchema } from "@/schema";',
          "",
          'export class ServerConfig extends ConfigProperties("server", serverSchema) {',
          '  label = "overrides-bound-values";',
          "}",
          "",
        ].join("\n"),
      },
      "INVALID_CONFIG_PROPERTIES",
      "field",
    );
  });

  test("requires a top-level named export", async () => {
    await expectSingleDiagnostic(
      {
        "schema.ts": plainSchemaSource,
        "server-config.ts": [
          'import { ConfigProperties } from "@reforce/config";',
          'import { serverSchema } from "@/schema";',
          "",
          'class ServerConfig extends ConfigProperties("server", serverSchema) {}',
          "",
        ].join("\n"),
      },
      "INVALID_CONFIG_PROPERTIES",
      "export",
    );
  });

  test("rejects decorator combinations on a config class", async () => {
    await expectSingleDiagnostic(
      {
        "schema.ts": plainSchemaSource,
        "server-config.ts": [
          'import { Injectable } from "@reforce/core";',
          'import { ConfigProperties } from "@reforce/config";',
          'import { serverSchema } from "@/schema";',
          "",
          "@Injectable()",
          'export class ServerConfig extends ConfigProperties("server", serverSchema) {}',
          "",
        ].join("\n"),
      },
      "INVALID_CONFIG_PROPERTIES",
      "decorator",
    );
  });

  test("rejects Lazy injection of a config class", async () => {
    const { result } = await compile(
      applicationTree({
        "schema.ts": plainSchemaSource,
        "server-config.ts": serverConfigSource,
        "consumer.ts": [
          'import { Injectable, type Lazy } from "@reforce/core";',
          'import { ServerConfig } from "@/server-config";',
          "",
          "@Injectable()",
          "export class Consumer {",
          "  constructor(readonly config: Lazy<ServerConfig>) {}",
          "}",
          "",
        ].join("\n"),
      }),
    );

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_CONFIG_INJECTION"]);
    expect(String(failure.diagnostics[0]?.sourceSpan?.fileId)).toBe("src/consumer.ts");
  });
});

// —— starter 开放边闭合：第一个真实消费场景 ——
// starter-linking.spec.ts:505 的 MISSING_BEAN 场景在补上 config class 后必须编译通过。

const redisDistDeclaration = [
  "export interface RedisSettings {",
  "  readonly url: string;",
  "}",
  "export declare class RedisClient {",
  "  constructor(settings: RedisSettings);",
  "  address(): string;",
  "}",
  starterHandleDeclaration("redisStarter"),
  "",
].join("\n");

const redisDistRuntime = [
  "export class RedisClient {",
  "  constructor(settings) {",
  "    this.settings = settings;",
  "  }",
  "  address() {",
  "    return this.settings.url;",
  "  }",
  "}",
  starterHandleRuntime("redisStarter"),
  "",
].join("\n");

const redisSymbols = [
  { id: "@acme/starter-redis#RedisClient", file: "dist/index.d.ts", subpaths: ["."] },
  { id: "@acme/starter-redis#RedisSettings", file: "dist/index.d.ts", subpaths: ["."] },
];

function redisMeta(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    starterDeps: [],
    symbols: redisSymbols,
    beans: [
      {
        id: "@acme/starter-redis#RedisClient",
        runtimeExport: { module: "@acme/starter-redis", export: "RedisClient" },
        provides: ["@acme/starter-redis#RedisClient"],
        dependencies: [{ contract: "@acme/starter-redis#RedisSettings", open: true }],
        defaultBean: false,
        role: "demand",
        source: starterMetaSpan("src/client.ts"),
      },
    ],
  };
}

function redisStarterPackage(): ProjectTree {
  return starterPackage({
    name: "@acme/starter-redis",
    version: "1.2.0",
    meta: redisMeta(),
    dist: {
      "index.d.ts": redisDistDeclaration,
      "index.js": redisDistRuntime,
    },
  });
}

const registrationSource = [
  'import { defineApplication } from "@reforce/core";',
  'import { redisStarter } from "@acme/starter-redis";',
  "",
  "export const application = defineApplication({ starters: [redisStarter] });",
  "",
].join("\n");

const redisConsumerSource = [
  'import { Injectable } from "@reforce/core";',
  'import { RedisClient } from "@acme/starter-redis";',
  "",
  "@Injectable()",
  "export class CacheReader {",
  "  constructor(readonly client: RedisClient) {}",
  "",
  "  address(): string {",
  "    return this.client.address();",
  "  }",
  "}",
  "",
].join("\n");

const redisConfigSource = [
  'import { ConfigProperties } from "@reforce/config";',
  'import type { RedisSettings } from "@acme/starter-redis";',
  'import { redisSchema } from "@/schema";',
  "",
  'export class AppRedisConfig extends ConfigProperties("redis", redisSchema) implements RedisSettings {}',
  "",
].join("\n");

describe("starter open edge closed by a config class", () => {
  test("compiles the previously missing open edge and wires it to the config", async () => {
    const result = await compileOrThrow(
      applicationTree(
        {
          "application.ts": registrationSource,
          "consumer.ts": redisConsumerSource,
          "schema.ts": plainSchemaSource.replace("serverSchema", "redisSchema"),
          "redis-config.ts": redisConfigSource,
        },
        { "@acme/starter-redis": redisStarterPackage() },
      ),
    );

    const manifest = manifestOf(result);
    const configId = "src/redis-config.ts#AppRedisConfig";
    expect(manifest.configs.map((config) => config.id)).toEqual([configId]);
    const starterBean = manifest.beans.find(
      (bean) => bean.id === "@acme/starter-redis#RedisClient",
    );
    expect(starterBean?.dependencies).toEqual([expect.objectContaining({ targetId: configId })]);
    expect(manifest.plans.constructionOrder).not.toContain(configId);
  });
});

// —— 生成物可执行：typecheck + bundle + run，.env 真值注入 ——

const typedSchemaSource = [
  "interface ServerValues {",
  "  readonly host: string;",
  "  readonly port: number;",
  "}",
  "",
  "type SchemaIssue = { readonly message: string; readonly path?: readonly (string | number)[] };",
  "type SchemaResult =",
  "  | { readonly value: ServerValues; readonly issues?: undefined }",
  "  | { readonly issues: readonly SchemaIssue[] };",
  "",
  "export const serverSchema = {",
  '  "~standard": {',
  "    version: 1 as const,",
  '    vendor: "reforce-it",',
  "    types: undefined as { readonly input: unknown; readonly output: ServerValues } | undefined,",
  "    validate: (value: unknown): SchemaResult => {",
  "      const record = (value ?? {}) as Record<string, unknown>; // IT fixture schema 自行窄化输入",
  '      const host = typeof record.host === "string" ? record.host : "localhost";',
  '      const port = typeof record.port === "string" ? Number(record.port) : Number.NaN;',
  "      if (Number.isNaN(port)) {",
  '        return { issues: [{ message: "port must be numeric", path: ["port"] }] };',
  "      }",
  "      return { value: { host, port } };",
  "    },",
  "  },",
  "};",
  "",
].join("\n");

const executableConfigSource = [
  'import { ConfigProperties } from "@reforce/config";',
  'import { serverSchema } from "@/schema";',
  "",
  'export class ServerConfig extends ConfigProperties("server", serverSchema) {}',
  "",
].join("\n");

const executableConsumerSource = [
  'import { Injectable } from "@reforce/core";',
  'import { ServerConfig } from "@/server-config";',
  "",
  "@Injectable()",
  "export class Endpoint {",
  "  constructor(readonly config: ServerConfig) {}",
  "",
  "  address(): string {",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture 源码里就是模板字符串
  "    return `${this.config.host}:${this.config.port}`;",
  "  }",
  "}",
  "",
].join("\n");

describe("config generation execution", () => {
  test("typechecks and executes a config-consuming application with .env layering", async () => {
    const result = await compileOrThrow(
      applicationTree({
        "schema.ts": typedSchemaSource,
        "server-config.ts": executableConfigSource,
        "consumer.ts": executableConsumerSource,
      }),
    );
    const project = temporaryProjects.at(-1);
    if (!project) {
      throw new Error("Missing temporary project");
    }
    const projectRoot = project.projectRoot;
    await linkApplicationPackages(projectRoot);
    await linkConfigPackage(projectRoot);

    const generatedDirectory = path.join(projectRoot, ".reforce", "generated");
    await mkdir(generatedDirectory, { recursive: true });
    await Promise.all(
      result.files.map((file) => writeFile(path.join(generatedDirectory, file.path), file.content)),
    );
    await writeFile(
      path.join(projectRoot, ".env"),
      ["SERVER_HOST=base-host", "SERVER_PORT=3000", ""].join("\n"),
    );
    await writeFile(path.join(projectRoot, ".env.local"), "SERVER_PORT=4000\n");
    await writeFile(
      path.join(projectRoot, "integration.ts"),
      [
        'import { bootstrap } from "./.reforce/generated/bootstrap.js";',
        'import { Endpoint } from "./src/consumer.js";',
        "",
        "const application = await bootstrap();",
        "console.log(JSON.stringify(application.get(Endpoint).address()));",
        "await application.close();",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(projectRoot, "tsconfig.integration.json"),
      `${JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: { noEmit: true },
        include: ["src", ".reforce/generated/**/*.ts", "integration.ts"],
      })}\n`,
    );

    const typescriptPackage = fileURLToPath(import.meta.resolve("typescript/package.json"));
    const tscPath = path.join(path.dirname(typescriptPackage), "bin", "tsc");
    const typecheck = await runCommand(
      process.execPath,
      [tscPath, "-p", "tsconfig.integration.json"],
      {
        cwd: projectRoot,
      },
    );
    expect(typecheck.stderr).toBe("");
    expect(typecheck.stdout).toBe("");
    expect(typecheck.exitCode).toBe(0);

    await bundleEntry({ entry: "integration.ts", cwd: projectRoot, outdir: "dist" });

    const execution = await runCommand(
      await resolveNodeExecutable(),
      [path.join(projectRoot, "dist", "integration.js")],
      { cwd: projectRoot, env: { ...process.env, REFORCE_PROFILE: undefined } },
    );
    // 绑定期现在会打来源摘要与逐键明细（RFC 0011 C4，#250）。这个最小应用没有日志绑定，
    // 记录由退出兜底按 short 单行文本吐出（L7），所以按 logger 名过滤而不是按 JSON 形状。
    // 断言收紧成「除了它没有别的输出」，而不是放宽成不看 stderr。
    const unexpected = String(execution.stderr)
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.includes("reforce.config"));
    expect(unexpected).toEqual([]);
    // .env.local 的 SERVER_PORT=4000 覆盖 .env 的 3000；host 来自 .env（五层语义的执行证据）。
    expect(String(execution.stdout).trim()).toBe(JSON.stringify("base-host:4000"));
    expect(execution.exitCode).toBe(0);
  });
});
