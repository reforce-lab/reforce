import {
  createTemporaryProject,
  type ProjectTree,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { afterEach, describe, expect, test } from "vitest";
import {
  type CompileLibraryResult,
  type CompileResult,
  createCompiler,
  type LibraryGeneratedFile,
} from "@/index";
import { applicationTsconfig, type CompileSuccess } from "./support/project";
import { nodeModulesTree, starterHandleDeclaration, starterPackage } from "./support/starters";

// ADR 0004（#120）M2 生产侧 IT（#147）：reforce lib 复用流水线中段编出 meta，schema 由
// linking/starter-meta.ts（M1，#145）钉死。闭环用例把编出的 meta 原样装进应用 node_modules 走
// M1 链接路径，并与同语义的手写 meta 逐字节比对生成产物；负向用例钉死生产侧提前拦截
// （runtimeExport 可达、形状相符、meta v1 表达不了的授权面）。

type LibraryFailure = Extract<CompileLibraryResult, { readonly status: "failure" }>;
type LibrarySuccess = Extract<CompileLibraryResult, { readonly status: "success" }>;

const temporaryProjects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

const libraryPackageName = "@acme/starter-redis";

const defaultExports = {
  ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
  "./client": { types: "./dist/client.d.ts", default: "./dist/client.js" },
  "./reforce-meta": "./reforce-meta.json",
};

const contractsSource = [
  "export interface Cache {",
  "  get(key: string): string;",
  "}",
  "export interface RedisConfig {",
  "  url(): string;",
  "}",
  "",
].join("\n");

const clientSource = [
  'import { Injectable, type OnContextClose } from "@reforce/core";',
  'import type { Cache, RedisConfig } from "./contracts";',
  "",
  "@Injectable()",
  "export class RedisClient implements Cache, OnContextClose {",
  "  private readonly prefix: string;",
  "",
  "  constructor(config: RedisConfig) {",
  "    this.prefix = config.url();",
  "  }",
  "",
  "  onContextClose(): void {}",
  "",
  "  get(key: string): string {",
  '    return this.prefix + ":" + key;',
  "  }",
  "}",
  "",
].join("\n");

const metricsSource = [
  'import { Injectable } from "@reforce/core";',
  'import { RedisClient } from "./client";',
  "",
  "@Injectable()",
  "export class MetricsPusher {",
  "  constructor(readonly client: RedisClient) {}",
  "}",
  "",
].join("\n");

const indexSource = [
  'import { defineStarter } from "@reforce/core";',
  "",
  'export { RedisClient } from "./client";',
  'export { MetricsPusher } from "./metrics";',
  'export type { Cache, RedisConfig } from "./contracts";',
  "",
  "export const redisStarter = defineStarter();",
  "",
].join("\n");

const defaultSources: Record<string, string> = {
  "contracts.ts": contractsSource,
  "client.ts": clientSource,
  "metrics.ts": metricsSource,
  "index.ts": indexSource,
};

const defaultDist: ProjectTree = {
  "contracts.d.ts": contractsSource,
  "contracts.js": "export {};\n",
  "client.d.ts": [
    'import type { Cache, RedisConfig } from "./contracts.js";',
    "export declare class RedisClient implements Cache {",
    "  constructor(config: RedisConfig);",
    "  onContextClose(): void;",
    "  get(key: string): string;",
    "}",
    "",
  ].join("\n"),
  "client.js": [
    "export class RedisClient {",
    "  constructor(config) {",
    "    this.prefix = config.url();",
    "  }",
    "  onContextClose() {}",
    "  get(key) {",
    '    return this.prefix + ":" + key;',
    "  }",
    "}",
    "",
  ].join("\n"),
  "metrics.d.ts": [
    'import { RedisClient } from "./client.js";',
    "export declare class MetricsPusher {",
    "  constructor(client: RedisClient);",
    "}",
    "",
  ].join("\n"),
  "metrics.js": [
    "export class MetricsPusher {",
    "  constructor(client) {",
    "    this.client = client;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "index.d.ts": [
    'export { RedisClient } from "./client.js";',
    'export { MetricsPusher } from "./metrics.js";',
    'export type { Cache, RedisConfig } from "./contracts.js";',
    starterHandleDeclaration("redisStarter"),
    "",
  ].join("\n"),
  "index.js": [
    'export { RedisClient } from "./client.js";',
    'export { MetricsPusher } from "./metrics.js";',
    "export const redisStarter = Object.freeze({});",
    "",
  ].join("\n"),
};

interface AuthorTreeOptions {
  readonly sources?: Record<string, string>;
  readonly dist?: ProjectTree;
  readonly exports?: Record<string, unknown> | "omitted";
  readonly packages?: Record<string, ProjectTree>;
}

function authorTree(options: AuthorTreeOptions = {}): ProjectTree {
  const packageJson: Record<string, unknown> = {
    name: libraryPackageName,
    version: "1.2.0",
    type: "module",
  };
  if (options.exports !== "omitted") {
    packageJson.exports = options.exports ?? defaultExports;
  }
  return {
    "package.json": `${JSON.stringify(packageJson)}\n`,
    "tsconfig.json": applicationTsconfig(["src"]),
    src: options.sources ?? defaultSources,
    ...(options.packages === undefined ? {} : { node_modules: nodeModulesTree(options.packages) }),
    dist: options.dist ?? defaultDist,
  };
}

async function compileLibrary(tree: ProjectTree): Promise<CompileLibraryResult> {
  const project = await createTemporaryProject(tree);
  temporaryProjects.push(project);
  const compiler = createCompiler();
  const resolution = await compiler.resolveLibraryProject({
    projectDirectory: project.projectRoot,
  });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  return compiler.compileLibrary({ project: resolution.project });
}

function expectLibrarySuccess(result: CompileLibraryResult): LibrarySuccess {
  if (result.status !== "success") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

function expectLibraryFailure(result: CompileLibraryResult): LibraryFailure {
  expect(result.status).toBe("failure");
  if (result.status !== "failure") {
    throw new Error("Expected a failed library compilation");
  }
  return result;
}

function generatedLibraryFile(
  result: LibrarySuccess,
  filePath: LibraryGeneratedFile["path"],
): string {
  const content = result.files.find((file) => file.path === filePath)?.content;
  if (content === undefined) {
    throw new Error(`Missing generated library file ${filePath}`);
  }
  return content;
}

interface ParsedMetaBean {
  readonly id: string;
  readonly source: {
    readonly file: string;
    readonly start: { readonly offset: number };
    readonly end: { readonly offset: number };
  };
  readonly [key: string]: unknown;
}

interface ParsedMeta {
  readonly schemaVersion: number;
  readonly starterDeps: readonly string[];
  readonly symbols: readonly Record<string, unknown>[];
  readonly beans: readonly ParsedMetaBean[];
}

function parseMeta(result: LibrarySuccess): ParsedMeta {
  return JSON.parse(generatedLibraryFile(result, "reforce-meta.json"));
}

function beanOf(meta: ParsedMeta, id: string): ParsedMetaBean {
  const bean = meta.beans.find((candidate) => candidate.id === id);
  if (bean === undefined) {
    throw new Error(`Missing meta bean ${id}`);
  }
  return bean;
}

describe("library compile", () => {
  test("emits meta symbols and beans for a starter library", async () => {
    const result = expectLibrarySuccess(await compileLibrary(authorTree()));

    expect(result.packageName).toBe(libraryPackageName);
    const meta = parseMeta(result);
    expect(meta.schemaVersion).toBe(1);
    expect(meta.starterDeps).toEqual([]);
    expect(meta.symbols).toEqual([
      { id: "@acme/starter-redis#Cache", file: "dist/contracts.d.ts", subpaths: ["."] },
      { id: "@acme/starter-redis#MetricsPusher", file: "dist/metrics.d.ts", subpaths: ["."] },
      {
        id: "@acme/starter-redis#RedisClient",
        file: "dist/client.d.ts",
        subpaths: [".", "./client"],
      },
      { id: "@acme/starter-redis#RedisConfig", file: "dist/contracts.d.ts", subpaths: ["."] },
    ]);

    const metrics = beanOf(meta, "@acme/starter-redis#MetricsPusher");
    expect(metrics.runtimeExport).toEqual({
      module: "@acme/starter-redis",
      export: "MetricsPusher",
    });
    expect(metrics.provides).toEqual(["@acme/starter-redis#MetricsPusher"]);
    expect(metrics.dependencies).toEqual([
      { contract: "@acme/starter-redis#RedisClient", open: false },
    ]);
    expect(metrics.lifecycle).toBeUndefined();
    expect(metrics.source.file).toBe("src/metrics.ts");

    const client = beanOf(meta, "@acme/starter-redis#RedisClient");
    expect(client.runtimeExport).toEqual({ module: "@acme/starter-redis", export: "RedisClient" });
    expect(client.provides).toEqual([
      "@acme/starter-redis#Cache",
      "@acme/starter-redis#RedisClient",
    ]);
    expect(client.dependencies).toEqual([
      { contract: "@acme/starter-redis#RedisConfig", open: true },
    ]);
    expect(client.lifecycle).toEqual({ close: "onContextClose" });
    expect(client.source.file).toBe("src/client.ts");
    const clientSpan = clientSource.slice(client.source.start.offset, client.source.end.offset);
    expect(clientSpan).toContain("class RedisClient");
  });

  test("compiles a starter library whose bean imports a Node.js builtin module", async () => {
    // #207：Node 引擎 starter（@reforce/web-node）把 node:http 的值引入带进库模式编译；
    // 内置模块没有文件落点，必须按外部符号静默通过，不得报 MODULE_RESOLUTION_FAILED。
    const result = expectLibrarySuccess(
      await compileLibrary(
        authorTree({
          sources: {
            "server.ts": [
              'import { createServer } from "node:http";',
              'import { Injectable } from "@reforce/core";',
              "",
              "@Injectable()",
              "export class HttpProbe {",
              "  listening(): boolean {",
              "    return createServer().listening;",
              "  }",
              "}",
              "",
            ].join("\n"),
            "index.ts": 'export { HttpProbe } from "./server";\n',
          },
          dist: {
            "server.d.ts": [
              "export declare class HttpProbe {",
              "  listening(): boolean;",
              "}",
              "",
            ].join("\n"),
            "server.js": [
              'import { createServer } from "node:http";',
              "export class HttpProbe {",
              "  listening() {",
              "    return createServer().listening;",
              "  }",
              "}",
              "",
            ].join("\n"),
            "index.d.ts": 'export { HttpProbe } from "./server.js";\n',
            "index.js": 'export { HttpProbe } from "./server.js";\n',
          },
          exports: {
            ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
            "./reforce-meta": "./reforce-meta.json",
          },
        }),
      ),
    );

    const meta = parseMeta(result);
    expect(meta.beans.map((bean) => bean.id)).toEqual(["@acme/starter-redis#HttpProbe"]);
  });

  test("normalizes dependency-starter contracts to meta coordinates and records starterDeps", async () => {
    const starterBase = starterPackage({
      name: "@acme/starter-base",
      meta: {
        schemaVersion: 1,
        starterDeps: [],
        symbols: [
          { id: "@acme/starter-base#BaseRemote", file: "dist/index.d.ts", subpaths: ["."] },
          { id: "@acme/starter-base#BaseTelemetry", file: "dist/index.d.ts", subpaths: ["."] },
        ],
        beans: [],
      },
      dist: {
        "index.d.ts": [
          "export interface BaseTelemetry {",
          "  push(metric: string): void;",
          "}",
          "export interface BaseRemote {",
          "  send(payload: string): void;",
          "}",
          "",
        ].join("\n"),
        "index.js": "export {};\n",
      },
    });
    const result = expectLibrarySuccess(
      await compileLibrary(
        authorTree({
          packages: { "@acme/starter-base": starterBase },
          sources: {
            "telemetry.ts": [
              'import { Injectable } from "@reforce/core";',
              'import type { BaseRemote, BaseTelemetry } from "@acme/starter-base";',
              "",
              "@Injectable()",
              "export class WiredTelemetry implements BaseTelemetry {",
              "  constructor(private readonly remote: BaseRemote) {}",
              "",
              "  push(metric: string): void {",
              "    this.remote.send(metric);",
              "  }",
              "}",
              "",
            ].join("\n"),
            "index.ts": 'export { WiredTelemetry } from "./telemetry";\n',
          },
          dist: {
            "telemetry.d.ts": [
              'import type { BaseTelemetry } from "@acme/starter-base";',
              "export declare class WiredTelemetry implements BaseTelemetry {",
              "  push(metric: string): void;",
              "}",
              "",
            ].join("\n"),
            "telemetry.js": "export class WiredTelemetry {}\n",
            "index.d.ts": 'export { WiredTelemetry } from "./telemetry.js";\n',
            "index.js": 'export { WiredTelemetry } from "./telemetry.js";\n',
          },
          exports: {
            ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
            "./reforce-meta": "./reforce-meta.json",
          },
        }),
      ),
    );

    const meta = parseMeta(result);
    expect(meta.starterDeps).toEqual(["@acme/starter-base"]);
    const bean = beanOf(meta, "@acme/starter-redis#WiredTelemetry");
    expect(bean.provides).toEqual([
      "@acme/starter-base#BaseTelemetry",
      "@acme/starter-redis#WiredTelemetry",
    ]);
    expect(bean.dependencies).toEqual([{ contract: "@acme/starter-base#BaseRemote", open: true }]);
  });

  test("keeps file coordinates for contract packages without meta", async () => {
    const result = expectLibrarySuccess(
      await compileLibrary(
        authorTree({
          packages: {
            "@acme/cache-api": {
              "package.json": `${JSON.stringify({
                name: "@acme/cache-api",
                version: "1.0.0",
                type: "module",
                exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
              })}\n`,
              dist: {
                "index.d.ts": [
                  "export interface SharedCache {",
                  "  get(key: string): string;",
                  "}",
                  "",
                ].join("\n"),
                "index.js": "export {};\n",
              },
            },
          },
          sources: {
            "cache.ts": [
              'import { Injectable } from "@reforce/core";',
              'import type { SharedCache } from "@acme/cache-api";',
              "",
              "@Injectable()",
              "export class MemoryCache implements SharedCache {",
              "  get(key: string): string {",
              "    return key;",
              "  }",
              "}",
              "",
            ].join("\n"),
            "index.ts": 'export { MemoryCache } from "./cache";\n',
          },
          dist: {
            "cache.d.ts": [
              'import type { SharedCache } from "@acme/cache-api";',
              "export declare class MemoryCache implements SharedCache {",
              "  get(key: string): string;",
              "}",
              "",
            ].join("\n"),
            "cache.js": "export class MemoryCache {}\n",
            "index.d.ts": 'export { MemoryCache } from "./cache.js";\n',
            "index.js": 'export { MemoryCache } from "./cache.js";\n',
          },
          exports: {
            ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
            "./reforce-meta": "./reforce-meta.json",
          },
        }),
      ),
    );

    const meta = parseMeta(result);
    expect(meta.starterDeps).toEqual([]);
    const bean = beanOf(meta, "@acme/starter-redis#MemoryCache");
    expect(bean.provides).toEqual([
      "@acme/cache-api:dist/index.d.ts#SharedCache",
      "@acme/starter-redis#MemoryCache",
    ]);
  });

  // 集合边是 starter 声明"用户可以提供 0..N 个实现"的唯一形态：单边下不写实现就是
  // MISSING_BEAN，starter 因此表达不了 configurer/customizer 这类可选扩展点。
  test("records a readonly T[] constructor parameter as a collection dependency edge", async () => {
    const result = expectLibrarySuccess(
      await compileLibrary(
        authorTree({
          sources: {
            ...defaultSources,
            "metrics.ts": [
              'import { Injectable } from "@reforce/core";',
              'import type { RedisConfig } from "./contracts";',
              "",
              "@Injectable()",
              "export class MetricsPusher {",
              "  constructor(readonly configs: readonly RedisConfig[]) {}",
              "}",
              "",
            ].join("\n"),
          },
          dist: {
            ...defaultDist,
            "metrics.d.ts": [
              'import type { RedisConfig } from "./contracts.js";',
              "export declare class MetricsPusher {",
              "  constructor(configs: readonly RedisConfig[]);",
              "}",
              "",
            ].join("\n"),
          },
        }),
      ),
    );

    // 包内无人 provides RedisConfig，因此 open: true——正是扩展点的形状：契约由 starter 声明，
    // 实现全部来自应用侧，数量 0..N 都合法。
    expect(beanOf(parseMeta(result), "@acme/starter-redis#MetricsPusher").dependencies).toEqual([
      { contract: "@acme/starter-redis#RedisConfig", open: true, collection: true },
    ]);
  });

  // collection 是可选键：单边不写它，已发布的 meta 字节因此一字不变
  test("omits the collection key on a plain contract edge", async () => {
    const result = expectLibrarySuccess(await compileLibrary(authorTree()));

    expect(beanOf(parseMeta(result), "@acme/starter-redis#MetricsPusher").dependencies).toEqual([
      { contract: "@acme/starter-redis#RedisClient", open: false },
    ]);
  });

  test("reports UNSUPPORTED_LIBRARY_DECLARATION for defineBean factories", async () => {
    const failure = expectLibraryFailure(
      await compileLibrary(
        authorTree({
          sources: {
            ...defaultSources,
            "factory.ts": [
              'import { defineBean } from "@reforce/core";',
              "",
              "export const clock = defineBean({",
              "  create: () => ({ now: () => 0 }),",
              "});",
              "",
            ].join("\n"),
          },
        }),
      ),
    );
    expect(failure.diagnostics[0].code).toBe("UNSUPPORTED_LIBRARY_DECLARATION");
    expect(failure.diagnostics[0].message).toContain("defineBean");
  });

  test("reports UNSUPPORTED_LIBRARY_DECLARATION for defineApplication in library sources", async () => {
    const failure = expectLibraryFailure(
      await compileLibrary(
        authorTree({
          sources: {
            ...defaultSources,
            "app.ts": [
              'import { defineApplication } from "@reforce/core";',
              "",
              "export default defineApplication({ starters: [] });",
              "",
            ].join("\n"),
          },
        }),
      ),
    );
    expect(failure.diagnostics[0].code).toBe("UNSUPPORTED_LIBRARY_DECLARATION");
    expect(failure.diagnostics[0].message).toContain("defineApplication");
  });

  // @Fallback() 的生成侧（#343）：在它之前 defaultBean 是「格式收、生成器不产」的字段，
  // 唯一的产出路径是手写 meta——@reforce/logging 就是这么来的。
  test("writes defaultBean for a Fallback-marked starter bean", async () => {
    const result = expectLibrarySuccess(
      await compileLibrary(
        authorTree({
          sources: {
            ...defaultSources,
            "client.ts": clientSource.replace(
              "@Injectable()",
              'import { Fallback } from "@reforce/core";\n@Injectable()\n@Fallback()',
            ),
          },
        }),
      ),
    );

    expect(beanOf(parseMeta(result), "@acme/starter-redis#RedisClient").defaultBean).toBe(true);
  });

  // 缺省即 false（读取侧把缺席归一为 false），所以不写这个键。
  test("omits defaultBean on a starter bean without Fallback", async () => {
    const result = expectLibrarySuccess(await compileLibrary(authorTree()));

    expect(
      beanOf(parseMeta(result), "@acme/starter-redis#RedisClient").defaultBean,
    ).toBeUndefined();
  });

  test("reports UNSUPPORTED_LIBRARY_DECLARATION for Primary and Qualifier decorators", async () => {
    const failure = expectLibraryFailure(
      await compileLibrary(
        authorTree({
          sources: {
            ...defaultSources,
            "client.ts": clientSource.replace(
              "@Injectable()",
              'import { Primary } from "@reforce/core";\n@Injectable()\n@Primary()',
            ),
          },
        }),
      ),
    );
    expect(failure.diagnostics[0].code).toBe("UNSUPPORTED_LIBRARY_DECLARATION");
    expect(failure.diagnostics[0].message).toContain("@Primary");
  });

  test("reports UNSUPPORTED_LIBRARY_DECLARATION for Lazy dependencies", async () => {
    const failure = expectLibraryFailure(
      await compileLibrary(
        authorTree({
          sources: {
            ...defaultSources,
            "metrics.ts": [
              'import { Injectable, type Lazy } from "@reforce/core";',
              'import { RedisClient } from "./client";',
              "",
              "@Injectable()",
              "export class MetricsPusher {",
              "  constructor(readonly client: Lazy<RedisClient>) {}",
              "}",
              "",
            ].join("\n"),
          },
        }),
      ),
    );
    expect(failure.diagnostics[0].code).toBe("UNSUPPORTED_LIBRARY_DECLARATION");
    expect(failure.diagnostics[0].message).toContain("Lazy");
  });

  test("reports UNSUPPORTED_LIBRARY_DECLARATION for the RequestScoped decorator", async () => {
    const failure = expectLibraryFailure(
      await compileLibrary(
        authorTree({
          sources: {
            ...defaultSources,
            "client.ts": clientSource.replace(
              "@Injectable()",
              'import { RequestScoped } from "@reforce/core";\n@Injectable()\n@RequestScoped()',
            ),
          },
        }),
      ),
    );
    expect(failure.diagnostics[0].code).toBe("UNSUPPORTED_LIBRARY_DECLARATION");
    expect(failure.diagnostics[0].message).toContain("@RequestScoped");
  });

  test("reports UNSUPPORTED_LIBRARY_DECLARATION for Current dependencies", async () => {
    const failure = expectLibraryFailure(
      await compileLibrary(
        authorTree({
          sources: {
            ...defaultSources,
            "metrics.ts": [
              'import { type Current, Injectable } from "@reforce/core";',
              'import { RedisClient } from "./client";',
              "",
              "@Injectable()",
              "export class MetricsPusher {",
              "  constructor(readonly client: Current<RedisClient>) {}",
              "}",
              "",
            ].join("\n"),
          },
        }),
      ),
    );
    expect(failure.diagnostics[0].code).toBe("UNSUPPORTED_LIBRARY_DECLARATION");
    expect(failure.diagnostics[0].message).toContain("Current");
  });

  // 方法级织入在库模式硬错三形态（ADR 0008 AM1，#202 硬错 #10）：meta v1 没有方法级槽位，
  // 静默丢弃违反"要么生效、要么编译错"。
  test("reports UNSUPPORTED_LIBRARY_DECLARATION for defineMethodMarker declarations", async () => {
    const failure = expectLibraryFailure(
      await compileLibrary(
        authorTree({
          sources: {
            ...defaultSources,
            "markers.ts": [
              'import { defineMethodMarker } from "@reforce/core";',
              'export const Audited = defineMethodMarker<{ label: string }>("audited");',
              "",
            ].join("\n"),
          },
        }),
      ),
    );
    expect(failure.diagnostics[0].code).toBe("UNSUPPORTED_LIBRARY_DECLARATION");
    expect(failure.diagnostics[0].message).toContain("defineMethodMarker");
  });

  test("reports UNSUPPORTED_LIBRARY_DECLARATION for the Interceptor decorator", async () => {
    const failure = expectLibraryFailure(
      await compileLibrary(
        authorTree({
          sources: {
            ...defaultSources,
            "markers.ts": [
              'import { defineMethodMarker } from "@reforce/core";',
              'export const Audited = defineMethodMarker<{ label: string }>("audited");',
              "",
            ].join("\n"),
            "client.ts": clientSource.replace(
              "@Injectable()",
              'import { Interceptor } from "@reforce/core";\nimport { Audited } from "./markers";\n@Interceptor({ marker: Audited })',
            ),
          },
        }),
      ),
    );
    const interceptor = failure.diagnostics.find((item) => item.message.includes("@Interceptor"));
    expect(interceptor?.code).toBe("UNSUPPORTED_LIBRARY_DECLARATION");
  });

  test("reports UNSUPPORTED_LIBRARY_DECLARATION for method marker uses", async () => {
    const failure = expectLibraryFailure(
      await compileLibrary(
        authorTree({
          sources: {
            ...defaultSources,
            "markers.ts": [
              'import { defineMethodMarker } from "@reforce/core";',
              'export const Audited = defineMethodMarker<{ label: string }>("audited");',
              "",
            ].join("\n"),
            "client.ts": [
              'import { Injectable } from "@reforce/core";',
              'import { Audited } from "./markers";',
              "",
              "@Injectable()",
              "export class RedisClient {",
              '  @Audited({ label: "ping" })',
              "  async ping(): Promise<void> {}",
              "}",
              "",
            ].join("\n"),
          },
        }),
      ),
    );
    const use = failure.diagnostics.find((item) => item.message.includes("Method markers"));
    expect(use?.code).toBe("UNSUPPORTED_LIBRARY_DECLARATION");
  });

  // route marker 在库模式同拒（#254）：meta v1 没有 marker 槽位，而应用编译对 d.ts 里的
  // marker 声明查表 miss 后按非 Reforce 装饰器静默丢弃——不拒就是"装了但不生效"。
  test("reports UNSUPPORTED_LIBRARY_DECLARATION for defineRouteMarker declarations", async () => {
    const failure = expectLibraryFailure(
      await compileLibrary(
        authorTree({
          sources: {
            ...defaultSources,
            "markers.ts": [
              'import { defineRouteMarker } from "@reforce/web-core";',
              'export const RateLimit = defineRouteMarker<{ max: number }>("rateLimit");',
              "",
            ].join("\n"),
          },
        }),
      ),
    );
    expect(failure.diagnostics[0].code).toBe("UNSUPPORTED_LIBRARY_DECLARATION");
    expect(failure.diagnostics[0].message).toContain("defineRouteMarker");
  });

  test("reports UNSUPPORTED_LIBRARY_DECLARATION for route marker uses", async () => {
    const failure = expectLibraryFailure(
      await compileLibrary(
        authorTree({
          sources: {
            ...defaultSources,
            "markers.ts": [
              'import { defineRouteMarker } from "@reforce/web-core";',
              'export const RateLimit = defineRouteMarker<{ max: number }>("rateLimit");',
              "",
            ].join("\n"),
            "client.ts": [
              'import { Injectable } from "@reforce/core";',
              'import { RateLimit } from "./markers";',
              "",
              "@Injectable()",
              "export class RedisClient {",
              "  @RateLimit({ max: 10 })",
              "  async ping(): Promise<void> {}",
              "}",
              "",
            ].join("\n"),
          },
        }),
      ),
    );
    const use = failure.diagnostics.find((item) => item.message.includes("Route markers"));
    expect(use?.code).toBe("UNSUPPORTED_LIBRARY_DECLARATION");
  });

  test("reports UNSUPPORTED_LIBRARY_DECLARATION for @Transactional uses", async () => {
    const failure = expectLibraryFailure(
      await compileLibrary(
        authorTree({
          sources: {
            ...defaultSources,
            "client.ts": [
              'import { Injectable } from "@reforce/core";',
              'import { Transactional } from "@reforce/transaction";',
              "",
              "@Injectable()",
              "export class RedisClient {",
              "  @Transactional()",
              "  async ping(): Promise<void> {}",
              "}",
              "",
            ].join("\n"),
          },
        }),
      ),
    );
    const use = failure.diagnostics.find((item) => item.message.includes("@Transactional"));
    expect(use?.code).toBe("UNSUPPORTED_LIBRARY_DECLARATION");
  });

  test("reports LIBRARY_EXPORT_MISMATCH when a bean class is not publicly exported", async () => {
    const failure = expectLibraryFailure(
      await compileLibrary(
        authorTree({
          sources: {
            ...defaultSources,
            "index.ts": [
              'export { RedisClient } from "./client";',
              'export type { Cache, RedisConfig } from "./contracts";',
              "",
            ].join("\n"),
          },
          dist: {
            ...defaultDist,
            "index.d.ts": [
              'export { RedisClient } from "./client.js";',
              'export type { Cache, RedisConfig } from "./contracts.js";',
              "",
            ].join("\n"),
          },
        }),
      ),
    );
    expect(failure.diagnostics[0].code).toBe("LIBRARY_EXPORT_MISMATCH");
    expect(failure.diagnostics[0].message).toContain("MetricsPusher");
  });

  test("reports LIBRARY_EXPORT_MISMATCH when the built dist declares a different shape", async () => {
    const failure = expectLibraryFailure(
      await compileLibrary(
        authorTree({
          dist: {
            ...defaultDist,
            "client.d.ts": [
              "export interface RedisClient {",
              "  get(key: string): string;",
              "}",
              "",
            ].join("\n"),
          },
        }),
      ),
    );
    expect(failure.diagnostics[0].code).toBe("LIBRARY_EXPORT_MISMATCH");
    expect(failure.diagnostics[0].message).toContain("RedisClient");
  });

  test("reports LIBRARY_EXPORT_MISMATCH when one export name anchors two declarations", async () => {
    const failure = expectLibraryFailure(
      await compileLibrary(
        authorTree({
          dist: {
            ...defaultDist,
            "other.d.ts": ["export declare class RedisClient {}", ""].join("\n"),
            "other.js": "export class RedisClient {}\n",
          },
          exports: {
            ...defaultExports,
            "./other": { types: "./dist/other.d.ts", default: "./dist/other.js" },
          },
        }),
      ),
    );
    expect(failure.diagnostics[0].code).toBe("LIBRARY_EXPORT_MISMATCH");
    expect(failure.diagnostics[0].message).toContain("two different declaration files");
  });

  test("reports INVALID_LIBRARY_PACKAGE when package.json declares no exports map", async () => {
    const failure = expectLibraryFailure(await compileLibrary(authorTree({ exports: "omitted" })));
    expect(failure.diagnostics[0].code).toBe("INVALID_LIBRARY_PACKAGE");
    expect(failure.diagnostics[0].message).toContain("exports");
  });
});

// —— 闭环：编出的 meta 原样喂给 M1 链接路径，行为与手写 meta 一致 ——

const registrationSource = [
  'import { defineApplication, Injectable } from "@reforce/core";',
  'import type { Cache, RedisConfig } from "@acme/starter-redis";',
  'import { redisStarter } from "@acme/starter-redis";',
  "",
  "@Injectable()",
  "export class LocalConfig implements RedisConfig {",
  "  url(): string {",
  '    return "redis://local";',
  "  }",
  "}",
  "",
  "@Injectable()",
  "export class CacheConsumer {",
  "  constructor(readonly cache: Cache) {}",
  "",
  "  read(key: string): string {",
  "    return this.cache.get(key);",
  "  }",
  "}",
  "",
  "export default defineApplication({ starters: [redisStarter] });",
  "",
].join("\n");

async function compileApplication(metaBytes: string): Promise<CompileSuccess> {
  const installed: ProjectTree = {
    ...starterPackage({
      name: libraryPackageName,
      version: "1.2.0",
      meta: {},
      dist: defaultDist,
      exports: defaultExports,
    }),
    "reforce-meta.json": metaBytes,
  };
  const project = await createTemporaryProject({
    "tsconfig.json": applicationTsconfig(),
    node_modules: nodeModulesTree({ [libraryPackageName]: installed }),
    src: { "main.ts": registrationSource },
  });
  temporaryProjects.push(project);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(JSON.stringify(resolution.diagnostics));
  }
  const result: CompileResult = await compiler.compile({ project: resolution.project });
  if (result.status === "failure") {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

describe("library compile closed loop", () => {
  test("meta compiled by reforce lib links exactly like the handwritten equivalent", async () => {
    const library = expectLibrarySuccess(await compileLibrary(authorTree()));
    const metaBytes = generatedLibraryFile(library, "reforce-meta.json");
    const produced = parseMeta(library);

    // 手写孪生：结构逐字段手写，仅 bean source span 取自产出（span 会进生成物，孪生必须同点位）。
    const handwritten = {
      schemaVersion: 1,
      starterDeps: [],
      symbols: [
        { id: "@acme/starter-redis#Cache", file: "dist/contracts.d.ts", subpaths: ["."] },
        { id: "@acme/starter-redis#MetricsPusher", file: "dist/metrics.d.ts", subpaths: ["."] },
        {
          id: "@acme/starter-redis#RedisClient",
          file: "dist/client.d.ts",
          subpaths: [".", "./client"],
        },
        { id: "@acme/starter-redis#RedisConfig", file: "dist/contracts.d.ts", subpaths: ["."] },
      ],
      beans: [
        {
          id: "@acme/starter-redis#MetricsPusher",
          runtimeExport: { module: "@acme/starter-redis", export: "MetricsPusher" },
          provides: ["@acme/starter-redis#MetricsPusher"],
          dependencies: [{ contract: "@acme/starter-redis#RedisClient", open: false }],
          source: beanOf(produced, "@acme/starter-redis#MetricsPusher").source,
        },
        {
          id: "@acme/starter-redis#RedisClient",
          runtimeExport: { module: "@acme/starter-redis", export: "RedisClient" },
          provides: ["@acme/starter-redis#Cache", "@acme/starter-redis#RedisClient"],
          dependencies: [{ contract: "@acme/starter-redis#RedisConfig", open: true }],
          lifecycle: { close: "onContextClose" },
          source: beanOf(produced, "@acme/starter-redis#RedisClient").source,
        },
      ],
    };
    expect(produced).toEqual(handwritten);

    const fromProduced = await compileApplication(metaBytes);
    const fromHandwritten = await compileApplication(
      `${JSON.stringify(handwritten, undefined, 2)}\n`,
    );
    expect(fromProduced.files).toEqual(fromHandwritten.files);

    const manifest = JSON.parse(
      fromProduced.files.find((file) => file.path === "manifest.json")?.content ?? "{}",
    );
    const beanIds = manifest.beans.map((bean: { id: string }) => bean.id);
    expect(beanIds).toContain("@acme/starter-redis#RedisClient");
    // MetricsPusher 无人需求：按需拉取语义必须原样穿过编出的 meta。
    expect(beanIds).not.toContain("@acme/starter-redis#MetricsPusher");
    const clientBean = manifest.beans.find(
      (bean: { id: string }) => bean.id === "@acme/starter-redis#RedisClient",
    );
    expect(clientBean.origin).toBe("@acme/starter-redis@1.2.0");
    const beansTs = fromProduced.files.find((file) => file.path === "beans.ts")?.content ?? "";
    expect(beansTs).toContain("import type { Cache as");
    expect(beansTs).toContain('from "@acme/starter-redis"');
  });
});
