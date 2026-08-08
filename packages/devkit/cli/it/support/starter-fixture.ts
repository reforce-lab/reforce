import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// dev-watch 三信号 IT（Issue #148）用的最小 starter 包。meta 手写：CLI 层只关心「watch 输入
// 变化触发重发现」，meta 由 `reforce lib` 真实编译的闭环归 compiler IT 与 e2e 把守。
// 形状与 packages/devkit/compiler/it/support/starters.ts 的契约一致（"." / "./reforce-meta" 两个
// subpath，注册 handle 是主入口的具名导出），但 CLI 的 IT 不允许反向依赖 compiler 的测试
// support，因此这里保留一份只含本层所需字段的副本。

export const starterName = "@acme/starter-redis";
export const starterVersion = "1.2.0";

const distDeclaration = [
  "export interface Cache {",
  "  get(key: string): string;",
  "}",
  "export declare class RedisClient implements Cache {",
  "  get(key: string): string;",
  "}",
  "export declare class MetricsPusher {}",
  'export declare const redisStarter: import("@reforce/core").StarterDefinition;',
  "",
].join("\n");

const distRuntime = [
  "export class RedisClient {",
  "  get(key) {",
  '    return "redis:" + key;',
  "  }",
  "}",
  "export class MetricsPusher {}",
  "export const redisStarter = Object.freeze({});",
  "",
].join("\n");

function metaSpan(file: string): Record<string, unknown> {
  return {
    file,
    start: { offset: 0, line: 0, character: 0 },
    end: { offset: 1, line: 0, character: 1 },
  };
}

export function starterMeta(
  options: { readonly withRootBean?: boolean; readonly defaultBean?: boolean } = {},
): string {
  const beans: Record<string, unknown>[] = [
    {
      id: `${starterName}#RedisClient`,
      runtimeExport: { module: starterName, export: "RedisClient" },
      provides: [`${starterName}#RedisClient`, `${starterName}#Cache`],
      dependencies: [],
      defaultBean: options.defaultBean === true,
      source: metaSpan("src/client.ts"),
    },
  ];
  if (options.withRootBean === true) {
    beans.push({
      id: `${starterName}#MetricsPusher`,
      runtimeExport: { module: starterName, export: "MetricsPusher" },
      provides: [`${starterName}#MetricsPusher`],
      dependencies: [],
      role: "root",
      source: metaSpan("src/metrics.ts"),
    });
  }
  return `${JSON.stringify({
    schemaVersion: 1,
    starterDeps: [],
    symbols: [
      { id: `${starterName}#Cache`, file: "dist/index.d.ts", subpaths: ["."] },
      { id: `${starterName}#MetricsPusher`, file: "dist/index.d.ts", subpaths: ["."] },
      { id: `${starterName}#RedisClient`, file: "dist/index.d.ts", subpaths: ["."] },
    ],
    beans,
  })}\n`;
}

// 把 starter 包写到任意目录（node_modules 内或 workspace 联调场景下的包目录本体）。
export async function writeStarterPackage(
  packageRoot: string,
  options: { readonly meta?: string } = {},
): Promise<void> {
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify({
      name: starterName,
      version: starterVersion,
      type: "module",
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./reforce-meta": "./reforce-meta.json",
      },
    })}\n`,
    "reforce-meta.json": options.meta ?? starterMeta(),
    "dist/index.d.ts": distDeclaration,
    "dist/index.js": distRuntime,
  };
  for (const [path, content] of Object.entries(files)) {
    const target = join(packageRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export const starterApplicationSources = {
  "application.ts": [
    'import { defineApplication } from "@reforce/core";',
    'import { redisStarter } from "@acme/starter-redis";',
    "",
    "export default defineApplication({ starters: [redisStarter] });",
    "",
  ].join("\n"),
  "consumer.ts": [
    'import { Injectable } from "@reforce/core";',
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
  ].join("\n"),
} as const;
