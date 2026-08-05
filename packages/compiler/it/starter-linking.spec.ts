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
import {
  applicationTsconfig,
  type CompileSuccess,
  linkApplicationPackages,
} from "./support/project";
import {
  contractPackage,
  nodeModulesTree,
  starterMetaSpan,
  starterPackage,
} from "./support/starters";

// ADR 0004（#120）M1 应用侧消费的链接语义 IT（#145）：输入是手写 meta JSON，
// 断言按需拉取、本地恒胜、defaultBean 让位、AMBIGUOUS_BEAN 带 origin、MISSING_BEAN 双侧定位，
// 以及包名 specifier 生成、typed-edge 与 manifest origin。

type FailureResult = Extract<CompileResult, { readonly status: "failure" }>;

const temporaryProjects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((project) => project.cleanup()));
});

function applicationTree(
  sources: Record<string, string>,
  packages: Record<string, ProjectTree>,
): ProjectTree {
  return {
    "tsconfig.json": applicationTsconfig(),
    node_modules: nodeModulesTree(packages),
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

interface ManifestBean {
  readonly id: string;
  readonly origin: string;
  readonly runtimeExport: {
    readonly moduleSpecifier: string;
    readonly exportName: string;
  };
  readonly dependencies: readonly {
    readonly parameterIndex: number;
    readonly targetId: string;
  }[];
}

interface GeneratedManifest {
  readonly beans: readonly ManifestBean[];
  readonly plans: { readonly constructionOrder: readonly string[] };
}

function generatedContent(result: CompileSuccess, filePath: GeneratedFile["path"]): string {
  const content = result.files.find((file) => file.path === filePath)?.content;
  if (content === undefined) {
    throw new Error(`Missing generated file ${filePath}`);
  }
  return content;
}

function manifestOf(result: CompileSuccess): GeneratedManifest {
  return JSON.parse(generatedContent(result, "manifest.json"));
}

function manifestBean(manifest: GeneratedManifest, id: string): ManifestBean {
  const bean = manifest.beans.find((candidate) => candidate.id === id);
  if (bean === undefined) {
    throw new Error(`Missing manifest Bean ${id}`);
  }
  return bean;
}

function relatedMessages(result: FailureResult): string {
  return JSON.stringify(
    result.diagnostics.flatMap((item) => item.related.map((entry) => entry.message)),
  );
}

// —— 基础 fixture：@acme/starter-redis ——

const redisDistDeclaration = [
  "export interface Cache {",
  "  get(key: string): string;",
  "}",
  "export interface RedisConfig {",
  "  url(): string;",
  "}",
  "export declare class RedisClient implements Cache {",
  "  constructor(config: RedisConfig);",
  "  get(key: string): string;",
  "}",
  "export declare class MetricsPusher {}",
  "export declare class OrphanTicker {}",
  "",
].join("\n");

const redisDistRuntime = [
  "export class RedisClient {",
  "  constructor(config) {",
  "    this.prefix = config.url();",
  "  }",
  "  get(key) {",
  '    return this.prefix + ":" + key;',
  "  }",
  "}",
  "export class MetricsPusher {}",
  "export class OrphanTicker {}",
  "",
].join("\n");

const redisSymbols = [
  { id: "@acme/starter-redis#Cache", file: "dist/index.d.ts", subpaths: ["."] },
  { id: "@acme/starter-redis#MetricsPusher", file: "dist/index.d.ts", subpaths: ["."] },
  { id: "@acme/starter-redis#OrphanTicker", file: "dist/index.d.ts", subpaths: ["."] },
  { id: "@acme/starter-redis#RedisClient", file: "dist/index.d.ts", subpaths: ["."] },
  { id: "@acme/starter-redis#RedisConfig", file: "dist/index.d.ts", subpaths: ["."] },
];

interface MetaBeanOverrides {
  readonly dependencies?: readonly unknown[];
  readonly runtimeExport?: { readonly module: string; readonly export: string };
}

function redisClientBean(overrides: MetaBeanOverrides = {}): Record<string, unknown> {
  return {
    id: "@acme/starter-redis#RedisClient",
    runtimeExport: overrides.runtimeExport ?? {
      module: "@acme/starter-redis",
      export: "RedisClient",
    },
    provides: ["@acme/starter-redis#RedisClient", "@acme/starter-redis#Cache"],
    dependencies: overrides.dependencies ?? [],
    source: starterMetaSpan("src/client.ts"),
  };
}

const redisConfigEdge = { contract: "@acme/starter-redis#RedisConfig", open: true };

function redisMeta(beans: readonly unknown[] = [redisClientBean()]): Record<string, unknown> {
  return { schemaVersion: 1, starterDeps: [], symbols: redisSymbols, beans };
}

function redisStarterPackage(
  meta: unknown = redisMeta(),
  options: { readonly version?: string; readonly dist?: ProjectTree } = {},
): ProjectTree {
  return starterPackage({
    name: "@acme/starter-redis",
    version: options.version ?? "1.2.0",
    meta,
    dist: options.dist ?? { "index.d.ts": redisDistDeclaration, "index.js": redisDistRuntime },
  });
}

const registrationSource = [
  'import { defineApplication } from "@reforce/context";',
  'import redisStarter from "@acme/starter-redis/reforce";',
  "",
  "export default defineApplication({ starters: [redisStarter] });",
  "",
].join("\n");

const cacheConsumerSource = [
  'import { Injectable } from "@reforce/context";',
  'import type { Cache } from "@acme/starter-redis";',
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
].join("\n");

const localConfigSource = [
  'import { Injectable } from "@reforce/context";',
  'import type { RedisConfig } from "@acme/starter-redis";',
  "",
  "@Injectable()",
  "export class LocalConfig implements RedisConfig {",
  "  url(): string {",
  '    return "redis://local";',
  "  }",
  "}",
  "",
].join("\n");

const redisClientId = "@acme/starter-redis#RedisClient";
const redisOrigin = "@acme/starter-redis@1.2.0";

// —— 共享 contract 包 + 两个竞争 starter ——

const cacheApiPackage = contractPackage({
  name: "@acme/cache-api",
  dist: {
    "index.d.ts": ["export interface Cache {", "  get(key: string): string;", "}", ""].join("\n"),
    "index.js": "export {};\n",
  },
});

const cacheApiContract = "@acme/cache-api:dist/index.d.ts#Cache";

function competingStarter(options: {
  readonly name: string;
  readonly version: string;
  readonly className: string;
  readonly defaultBean?: boolean;
}): ProjectTree {
  const packageCoordinate = `${options.name}#${options.className}`;
  return starterPackage({
    name: options.name,
    version: options.version,
    meta: {
      schemaVersion: 1,
      starterDeps: [],
      symbols: [{ id: packageCoordinate, file: "dist/index.d.ts", subpaths: ["."] }],
      beans: [
        {
          id: packageCoordinate,
          runtimeExport: { module: options.name, export: options.className },
          provides: [packageCoordinate, cacheApiContract],
          dependencies: [],
          ...(options.defaultBean === true ? { defaultBean: true } : {}),
          source: starterMetaSpan("src/impl.ts"),
        },
      ],
    },
    dist: {
      "index.d.ts": [
        'import type { Cache } from "@acme/cache-api";',
        `export declare class ${options.className} implements Cache {`,
        "  get(key: string): string;",
        "}",
        "",
      ].join("\n"),
      "index.js": [
        `export class ${options.className} {`,
        "  get(key) {",
        `    return "${options.className}:" + key;`,
        "  }",
        "}",
        "",
      ].join("\n"),
    },
  });
}

const sharedCacheConsumerSource = [
  'import { Injectable } from "@reforce/context";',
  'import type { Cache } from "@acme/cache-api";',
  "",
  "@Injectable()",
  "export class SharedCacheConsumer {",
  "  constructor(readonly cache: Cache) {}",
  "}",
  "",
].join("\n");

function competingRegistrationSource(packageNames: readonly string[]): string {
  return [
    'import { defineApplication } from "@reforce/context";',
    ...packageNames.map(
      (name, index) => `import starter${index} from ${JSON.stringify(`${name}/reforce`)};`,
    ),
    "",
    `export default defineApplication({ starters: [${packageNames
      .map((_, index) => `starter${index}`)
      .join(", ")}] });`,
    "",
  ].join("\n");
}

describe("starter linking semantics", () => {
  test("pulls a starter bean into the application graph on demand", async () => {
    const result = await compileOrThrow(
      applicationTree(
        { "application.ts": registrationSource, "consumer.ts": cacheConsumerSource },
        { "@acme/starter-redis": redisStarterPackage() },
      ),
    );

    const manifest = manifestOf(result);
    const starterBean = manifestBean(manifest, redisClientId);
    const consumerBean = manifestBean(manifest, "src/consumer.ts#CacheConsumer");
    expect(starterBean.origin).toBe(redisOrigin);
    expect(consumerBean.origin).toBe("application");
    expect(consumerBean.dependencies.map((item) => item.targetId)).toEqual([redisClientId]);
    expect(manifest.plans.constructionOrder.indexOf(redisClientId)).toBeLessThan(
      manifest.plans.constructionOrder.indexOf("src/consumer.ts#CacheConsumer"),
    );
  });

  test("omits starter beans that no local root demands", async () => {
    const orphanBean = {
      id: "@acme/starter-redis#OrphanTicker",
      runtimeExport: { module: "@acme/starter-redis", export: "OrphanTicker" },
      provides: ["@acme/starter-redis#OrphanTicker"],
      dependencies: [{ contract: "@acme/starter-redis#Absent", open: true }],
      source: starterMetaSpan("src/orphan.ts"),
    };
    const result = await compileOrThrow(
      applicationTree(
        { "application.ts": registrationSource, "consumer.ts": cacheConsumerSource },
        { "@acme/starter-redis": redisStarterPackage(redisMeta([redisClientBean(), orphanBean])) },
      ),
    );

    const manifest = manifestOf(result);
    expect(manifest.beans.map((bean) => bean.id)).not.toContain("@acme/starter-redis#OrphanTicker");
    expect(manifest.plans.constructionOrder).not.toContain("@acme/starter-redis#OrphanTicker");
  });

  test("constructs a root starter bean without local demand", async () => {
    const rootBean = {
      id: "@acme/starter-redis#MetricsPusher",
      runtimeExport: { module: "@acme/starter-redis", export: "MetricsPusher" },
      provides: ["@acme/starter-redis#MetricsPusher"],
      dependencies: [],
      role: "root",
      source: starterMetaSpan("src/metrics.ts"),
    };
    const result = await compileOrThrow(
      applicationTree(
        { "application.ts": registrationSource },
        { "@acme/starter-redis": redisStarterPackage(redisMeta([rootBean])) },
      ),
    );

    const manifest = manifestOf(result);
    expect(manifestBean(manifest, "@acme/starter-redis#MetricsPusher").origin).toBe(redisOrigin);
    expect(manifest.plans.constructionOrder).toContain("@acme/starter-redis#MetricsPusher");
  });

  test("keeps a local provider over a starter candidate", async () => {
    const localCacheSource = [
      'import { Injectable } from "@reforce/context";',
      'import type { Cache } from "@acme/starter-redis";',
      "",
      "@Injectable()",
      "export class LocalCache implements Cache {",
      "  get(key: string): string {",
      '    return "local:" + key;',
      "  }",
      "}",
      "",
    ].join("\n");
    const result = await compileOrThrow(
      applicationTree(
        {
          "application.ts": registrationSource,
          "consumer.ts": cacheConsumerSource,
          "local-cache.ts": localCacheSource,
        },
        { "@acme/starter-redis": redisStarterPackage() },
      ),
    );

    const manifest = manifestOf(result);
    expect(manifest.beans.map((bean) => bean.id)).not.toContain(redisClientId);
    expect(
      manifestBean(manifest, "src/consumer.ts#CacheConsumer").dependencies.map(
        (item) => item.targetId,
      ),
    ).toEqual(["src/local-cache.ts#LocalCache"]);
  });

  test("retires a defaultBean when another starter provides the contract", async () => {
    const result = await compileOrThrow(
      applicationTree(
        {
          "application.ts": competingRegistrationSource(["@acme/starter-a", "@acme/starter-b"]),
          "consumer.ts": sharedCacheConsumerSource,
        },
        {
          "@acme/cache-api": cacheApiPackage,
          "@acme/starter-a": competingStarter({
            name: "@acme/starter-a",
            version: "1.0.0",
            className: "DefaultCache",
            defaultBean: true,
          }),
          "@acme/starter-b": competingStarter({
            name: "@acme/starter-b",
            version: "3.1.4",
            className: "TunedCache",
          }),
        },
      ),
    );

    const manifest = manifestOf(result);
    expect(manifest.beans.map((bean) => bean.id)).not.toContain("@acme/starter-a#DefaultCache");
    expect(
      manifestBean(manifest, "src/consumer.ts#SharedCacheConsumer").dependencies.map(
        (item) => item.targetId,
      ),
    ).toEqual(["@acme/starter-b#TunedCache"]);
  });

  test("keeps a lone defaultBean as the contract provider", async () => {
    const result = await compileOrThrow(
      applicationTree(
        {
          "application.ts": competingRegistrationSource(["@acme/starter-a"]),
          "consumer.ts": sharedCacheConsumerSource,
        },
        {
          "@acme/cache-api": cacheApiPackage,
          "@acme/starter-a": competingStarter({
            name: "@acme/starter-a",
            version: "1.0.0",
            className: "DefaultCache",
            defaultBean: true,
          }),
        },
      ),
    );

    expect(
      manifestBean(manifestOf(result), "src/consumer.ts#SharedCacheConsumer").dependencies.map(
        (item) => item.targetId,
      ),
    ).toEqual(["@acme/starter-a#DefaultCache"]);
  });

  test("reports AMBIGUOUS_BEAN with starter origins", async () => {
    const { result } = await compile(
      applicationTree(
        {
          "application.ts": competingRegistrationSource(["@acme/starter-a", "@acme/starter-b"]),
          "consumer.ts": sharedCacheConsumerSource,
        },
        {
          "@acme/cache-api": cacheApiPackage,
          "@acme/starter-a": competingStarter({
            name: "@acme/starter-a",
            version: "1.0.0",
            className: "PlainCache",
          }),
          "@acme/starter-b": competingStarter({
            name: "@acme/starter-b",
            version: "3.1.4",
            className: "TunedCache",
          }),
        },
      ),
    );

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["AMBIGUOUS_BEAN"]);
    const related = relatedMessages(failure);
    expect(related).toContain("@acme/starter-a@1.0.0");
    expect(related).toContain("@acme/starter-b@3.1.4");
  });

  test("reports MISSING_BEAN with the demand-side span and the starter source", async () => {
    const { result } = await compile(
      applicationTree(
        { "application.ts": registrationSource, "consumer.ts": cacheConsumerSource },
        {
          "@acme/starter-redis": redisStarterPackage(
            redisMeta([redisClientBean({ dependencies: [redisConfigEdge] })]),
          ),
        },
      ),
    );

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["MISSING_BEAN"]);
    expect(String(failure.diagnostics[0].sourceSpan?.fileId)).toBe("src/consumer.ts");
    const related = relatedMessages(failure);
    expect(related).toContain("@acme/starter-redis");
    expect(related).toContain("src/client.ts");
  });

  test("satisfies a starter open edge with a local provider", async () => {
    const result = await compileOrThrow(
      applicationTree(
        {
          "application.ts": registrationSource,
          "config.ts": localConfigSource,
          "consumer.ts": cacheConsumerSource,
        },
        {
          "@acme/starter-redis": redisStarterPackage(
            redisMeta([redisClientBean({ dependencies: [redisConfigEdge] })]),
          ),
        },
      ),
    );

    const manifest = manifestOf(result);
    expect(manifestBean(manifest, redisClientId).dependencies.map((item) => item.targetId)).toEqual(
      ["src/config.ts#LocalConfig"],
    );
    const order = manifest.plans.constructionOrder;
    expect(order.indexOf("src/config.ts#LocalConfig")).toBeLessThan(order.indexOf(redisClientId));
  });

  test("pulls transitive starters through starterDeps", async () => {
    const facadeStarter = starterPackage({
      name: "@acme/starter-cache",
      version: "2.0.0",
      meta: {
        schemaVersion: 1,
        starterDeps: ["@acme/starter-redis"],
        symbols: [
          { id: "@acme/starter-cache#CacheFacade", file: "dist/index.d.ts", subpaths: ["."] },
        ],
        beans: [
          {
            id: "@acme/starter-cache#CacheFacade",
            runtimeExport: { module: "@acme/starter-cache", export: "CacheFacade" },
            provides: ["@acme/starter-cache#CacheFacade"],
            dependencies: [{ contract: "@acme/starter-redis#Cache", open: false }],
            source: starterMetaSpan("src/facade.ts"),
          },
        ],
      },
      dist: {
        "index.d.ts": [
          'import type { Cache } from "@acme/starter-redis";',
          "export declare class CacheFacade {",
          "  constructor(cache: Cache);",
          "  read(key: string): string;",
          "}",
          "",
        ].join("\n"),
        "index.js": [
          "export class CacheFacade {",
          "  constructor(cache) {",
          "    this.cache = cache;",
          "  }",
          "  read(key) {",
          "    return this.cache.get(key);",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    });
    const facadeConsumerSource = [
      'import { Injectable } from "@reforce/context";',
      'import type { CacheFacade } from "@acme/starter-cache";',
      "",
      "@Injectable()",
      "export class FacadeConsumer {",
      "  constructor(readonly facade: CacheFacade) {}",
      "}",
      "",
    ].join("\n");
    const result = await compileOrThrow(
      applicationTree(
        {
          "application.ts": competingRegistrationSource(["@acme/starter-cache"]),
          "consumer.ts": facadeConsumerSource,
        },
        {
          "@acme/starter-cache": facadeStarter,
          "@acme/starter-redis": redisStarterPackage(),
        },
      ),
    );

    const manifest = manifestOf(result);
    expect(manifestBean(manifest, "@acme/starter-cache#CacheFacade").origin).toBe(
      "@acme/starter-cache@2.0.0",
    );
    expect(manifestBean(manifest, redisClientId).origin).toBe(redisOrigin);
    expect(
      manifestBean(manifest, "@acme/starter-cache#CacheFacade").dependencies.map(
        (item) => item.targetId,
      ),
    ).toEqual([redisClientId]);
  });

  test("links contracts through declaration re-export chains", async () => {
    const chainedDist: ProjectTree = {
      "index.d.ts": 'export * from "./client";\n',
      "index.js": 'export * from "./client.js";\n',
      "client.d.ts": redisDistDeclaration,
      "client.js": redisDistRuntime,
    };
    const chainedSymbols = redisSymbols.map((symbol) => ({
      ...symbol,
      file: "dist/client.d.ts",
    }));
    const result = await compileOrThrow(
      applicationTree(
        { "application.ts": registrationSource, "consumer.ts": cacheConsumerSource },
        {
          "@acme/starter-redis": redisStarterPackage(
            {
              schemaVersion: 1,
              starterDeps: [],
              symbols: chainedSymbols,
              beans: [redisClientBean()],
            },
            { dist: chainedDist },
          ),
        },
      ),
    );

    expect(manifestBean(manifestOf(result), redisClientId).origin).toBe(redisOrigin);
  });
});

describe("defineApplication reading", () => {
  test("rejects a non-literal starters option", async () => {
    const source = [
      'import { defineApplication } from "@reforce/context";',
      'import redisStarter from "@acme/starter-redis/reforce";',
      "",
      "const starters = [redisStarter];",
      "export default defineApplication({ starters });",
      "",
    ].join("\n");
    const { result } = await compile(
      applicationTree(
        { "application.ts": source },
        { "@acme/starter-redis": redisStarterPackage() },
      ),
    );

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_DEFINE_APPLICATION"]);
  });

  test("rejects duplicate starter registration", async () => {
    const source = [
      'import { defineApplication } from "@reforce/context";',
      'import redisStarter from "@acme/starter-redis/reforce";',
      'import redisAgain from "@acme/starter-redis/reforce";',
      "",
      "export default defineApplication({ starters: [redisStarter, redisAgain] });",
      "",
    ].join("\n");
    const { result } = await compile(
      applicationTree(
        { "application.ts": source },
        { "@acme/starter-redis": redisStarterPackage() },
      ),
    );

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual([
      "DUPLICATE_STARTER_REGISTRATION",
    ]);
  });

  test("rejects a second defineApplication declaration", async () => {
    const emptyRegistration = [
      'import { defineApplication } from "@reforce/context";',
      "",
      "export default defineApplication({ starters: [] });",
      "",
    ].join("\n");
    const { result } = await compile(
      applicationTree({ "application.ts": emptyRegistration, "second.ts": emptyRegistration }, {}),
    );

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual([
      "INVALID_DEFINE_APPLICATION",
      "INVALID_DEFINE_APPLICATION",
    ]);
  });

  test("reports STARTER_META_NOT_FOUND for an unresolvable starter package", async () => {
    const source = [
      'import { defineApplication } from "@reforce/context";',
      'import missingStarter from "@acme/missing/reforce";',
      "",
      "export default defineApplication({ starters: [missingStarter] });",
      "",
    ].join("\n");
    const { result } = await compile(applicationTree({ "application.ts": source }, {}));

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["STARTER_META_NOT_FOUND"]);
  });

  test("reports STARTER_META_NOT_FOUND when the package exposes no reforce-meta subpath", async () => {
    const bare = starterPackage({
      name: "@acme/starter-redis",
      meta: redisMeta(),
      dist: { "index.d.ts": redisDistDeclaration, "index.js": redisDistRuntime },
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./reforce": { types: "./reforce.d.ts", default: "./reforce.js" },
      },
    });
    const { result } = await compile(
      applicationTree({ "application.ts": registrationSource }, { "@acme/starter-redis": bare }),
    );

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["STARTER_META_NOT_FOUND"]);
  });
});

describe("starter meta validation", () => {
  test("rejects an unsupported meta schemaVersion", async () => {
    const meta = { ...redisMeta(), schemaVersion: 2 };
    const { result } = await compile(
      applicationTree(
        { "application.ts": registrationSource },
        { "@acme/starter-redis": redisStarterPackage(meta) },
      ),
    );

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual([
      "UNSUPPORTED_STARTER_META_VERSION",
    ]);
  });

  test("rejects malformed starter meta", async () => {
    const { result } = await compile(
      applicationTree(
        { "application.ts": registrationSource },
        { "@acme/starter-redis": redisStarterPackage({ schemaVersion: 1 }) },
      ),
    );

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["INVALID_STARTER_META"]);
  });

  test("reports STARTER_META_RUNTIME_MISMATCH for a missing runtime export", async () => {
    const meta = redisMeta([
      redisClientBean({ runtimeExport: { module: "@acme/starter-redis", export: "Nope" } }),
    ]);
    const { result } = await compile(
      applicationTree(
        { "application.ts": registrationSource },
        { "@acme/starter-redis": redisStarterPackage(meta) },
      ),
    );

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["STARTER_META_RUNTIME_MISMATCH"]);
  });

  test("reports STARTER_META_RUNTIME_MISMATCH when the runtime export is not a class", async () => {
    const meta = redisMeta([
      redisClientBean({ runtimeExport: { module: "@acme/starter-redis", export: "Cache" } }),
    ]);
    const { result } = await compile(
      applicationTree(
        { "application.ts": registrationSource },
        { "@acme/starter-redis": redisStarterPackage(meta) },
      ),
    );

    const failure = expectFailure(result);
    expect(failure.diagnostics.map((item) => item.code)).toEqual(["STARTER_META_RUNTIME_MISMATCH"]);
  });
});

describe("starter generation", () => {
  const generationTree = applicationTree(
    {
      "application.ts": registrationSource,
      "config.ts": localConfigSource,
      "consumer.ts": cacheConsumerSource,
    },
    {
      "@acme/starter-redis": redisStarterPackage(
        redisMeta([redisClientBean({ dependencies: [redisConfigEdge] })]),
      ),
    },
  );

  test("emits package-specifier imports and typed edges", async () => {
    const result = await compileOrThrow(generationTree);

    const beans = generatedContent(result, "beans.ts");
    expect(beans).toContain('from "@acme/starter-redis";');
    expect(beans).toContain("import type {");
    expect(beans).toContain("resolver.resolve<");
    const manifest = manifestOf(result);
    expect(manifestBean(manifest, redisClientId).runtimeExport).toEqual({
      moduleSpecifier: "@acme/starter-redis",
      exportName: "RedisClient",
    });
  });

  test("keeps starter-linked output deterministic across compilers", async () => {
    const first = await compileOrThrow(generationTree);
    const second = await compileOrThrow(generationTree);

    expect(first.files).toEqual(second.files);
  });

  test("typechecks and executes a starter-consuming application", async () => {
    const project = await createTemporaryProject(generationTree);
    temporaryProjects.push(project);
    await linkApplicationPackages(project.projectRoot);
    const compiler = createCompiler();
    const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
    if (resolution.status === "failure") {
      throw new Error(JSON.stringify(resolution.diagnostics));
    }
    const compilation = await compiler.compile({ project: resolution.project });
    if (compilation.status === "failure") {
      throw new Error(JSON.stringify(compilation.diagnostics));
    }
    const generatedDirectory = path.join(project.projectRoot, ".reforce", "generated");
    await mkdir(generatedDirectory, { recursive: true });
    await Promise.all(
      compilation.files.map((file) =>
        writeFile(path.join(generatedDirectory, file.path), file.content),
      ),
    );
    await writeFile(
      path.join(project.projectRoot, "integration.ts"),
      [
        'import { bootstrap } from "./.reforce/generated/bootstrap.js";',
        'import { CacheConsumer } from "./src/consumer.js";',
        "",
        "const context = await bootstrap();",
        'const value = context.get(CacheConsumer).read("answer");',
        "await context.close();",
        "console.log(JSON.stringify(value));",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(project.projectRoot, "tsconfig.integration.json"),
      `${JSON.stringify(
        {
          extends: "./tsconfig.json",
          compilerOptions: { noEmit: true },
          include: ["src", ".reforce/generated/**/*.ts", "integration.ts"],
        },
        undefined,
        2,
      )}\n`,
    );
    const typescriptPackage = fileURLToPath(import.meta.resolve("typescript/package.json"));
    const typecheck = await runCommand(
      process.execPath,
      [path.join(path.dirname(typescriptPackage), "bin", "tsc"), "-p", "tsconfig.integration.json"],
      { cwd: project.projectRoot },
    );
    expect(typecheck.exitCode).toBe(0);
    expect(typecheck.stderr).toBe("");
    await bundleEntry({ entry: "integration.ts", cwd: project.projectRoot, outdir: "dist" });
    const execution = await runCommand(
      await resolveNodeExecutable(),
      [path.join(project.projectRoot, "dist", "integration.js")],
      { cwd: project.projectRoot },
    );
    expect(execution.exitCode).toBe(0);
    expect(execution.stdout).toBe(JSON.stringify("redis://local:answer"));
  });
});
