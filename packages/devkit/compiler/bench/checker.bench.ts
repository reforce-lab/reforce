// 基准(RFC 0012 S1,#273):tsgo checker 接入的 go/no-go 三组数字。直连
// typescript/unstable/sync(与 src/typescript/unstable-api.ts 同入口)测同步 IPC 的经济学——
// 门面层只加本地 WeakSet/缓存,开销可忽略,这里量的是决定成败的传输与 server 端成本。
// 复跑:`pnpm --dir packages/devkit/compiler run bench:checker`。
//
// 三组:
//   A 冷启动:spawn + 首个 updateSnapshot + 代表性查询负载,对照同项目 tsgo `tsc -p` 全量
//     检查基线(增幅判据 ≤1×);500/2000 文件合成项目 + 仓库自身 packages/devkit/compiler。
//   B dev-watch 增量:30 轮改一个文件 → fileChanges → 重放该文件查询,p50/p95(判据 ≤300ms);
//     对照每轮全新 API 重开的成本(snapshot 复用收益)。
//   C 批量对比:逐个 vs 一批 getTypeAtPosition;getPropertiesOfType 逐对象往返均摊
//     (判据 ≤1ms/趟);dev 版 memoization 的重复查询收益。

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API, type Snapshot } from "typescript/unstable/sync";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
// tsgo 原生二进制随 typescript 的平台 optional dep 安装,从 typescript 的真实安装位向邻包解析。
const typescriptDirectory = realpathSync(
  path.dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))),
);
const tsgoBinary = path.join(
  typescriptDirectory,
  "..",
  "@typescript",
  `typescript-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`,
  "lib",
  "tsc",
);

interface SyntheticProject {
  readonly root: string;
  readonly tsconfigPath: string;
  readonly files: readonly string[];
}

function generateProject(fileCount: number): SyntheticProject {
  const root = mkdtempSync(path.join(tmpdir(), "reforce-checker-bench-"));
  const sourceDirectory = path.join(root, "src");
  mkdirSync(sourceDirectory);
  const files: string[] = [];
  for (let index = 0; index < fileCount; index += 1) {
    const neighbor = (index + 1) % fileCount;
    const filePath = path.join(sourceDirectory, `contract${index}.ts`);
    writeFileSync(
      filePath,
      [
        `import type { Address${neighbor} } from "./contract${neighbor}";`,
        `export interface User${index} {`,
        "  id: number;",
        "  name: string;",
        "  tags: readonly string[];",
        `  address: Address${index};`,
        `  neighbor: Address${neighbor} | null;`,
        '  kind: "active" | "archived";',
        "  createdAt: Date;",
        "}",
        `export interface Address${index} {`,
        "  city: string;",
        "  zip?: string;",
        `  next?: Address${index};`,
        "}",
        "",
      ].join("\n"),
    );
    files.push(filePath);
  }
  const tsconfigPath = path.join(root, "tsconfig.json");
  writeFileSync(
    tsconfigPath,
    `${JSON.stringify({
      compilerOptions: {
        target: "esnext",
        module: "esnext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
      },
      include: ["src"],
    })}\n`,
  );
  return { root, tsconfigPath, files };
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

function tscBaselineMs(tsconfigPath: string): number {
  const start = performance.now();
  try {
    execFileSync(tsgoBinary, ["-p", tsconfigPath], { stdio: "pipe" });
  } catch {
    // 类型错误非零退出也计入完整检查耗时。
  }
  return performance.now() - start;
}

// 代表性查询负载:对文件里的 User 接口取类型,展开属性并批量取属性类型——正是字段表
// 每契约的查询形状。返回发出的 IPC 概况由 collectTiming 汇总。
function queryContractLoad(
  api: API,
  snapshot: Snapshot,
  tsconfigPath: string,
  files: readonly string[],
  sampleEvery: number,
): number {
  const project = snapshot.getProject(tsconfigPath);
  if (project === undefined) {
    throw new Error("project not loaded");
  }
  const checker = project.checker;
  let contracts = 0;
  for (let index = 0; index < files.length; index += sampleEvery) {
    const file = files[index];
    if (file === undefined) {
      continue;
    }
    const offset =
      readFileSync(file, "utf8").indexOf("export interface User") + "export interface ".length;
    const type = checker.getTypeAtPosition(file, offset);
    if (type === undefined) {
      continue;
    }
    const properties = type.getProperties();
    const types = checker.getTypeOfSymbol(properties);
    for (const propertyType of types) {
      if (propertyType.isUnionType()) {
        propertyType.getTypes();
      }
      if (propertyType.isTypeReference()) {
        checker.getTypeArguments(propertyType);
      }
    }
    contracts += 1;
  }
  return contracts;
}

interface ColdResult {
  readonly label: string;
  readonly fileCount: number;
  readonly spawnAndSnapshotMs: number;
  readonly queryLoadMs: number;
  readonly contracts: number;
  readonly requestCount: number;
  readonly roundTripMs: number;
  readonly serverTimeMs: number;
  readonly bytes: number;
  readonly tscBaselineMs: number;
}

function coldRun(label: string, project: SyntheticProject, sampleEvery: number): ColdResult {
  const baseline = tscBaselineMs(project.tsconfigPath);
  const api = new API({ cwd: project.root, collectTiming: true });
  try {
    const t0 = performance.now();
    const snapshot = api.updateSnapshot({ openProjects: [project.tsconfigPath] });
    const t1 = performance.now();
    const contracts = queryContractLoad(
      api,
      snapshot,
      project.tsconfigPath,
      project.files,
      sampleEvery,
    );
    const t2 = performance.now();
    const timing = api.getTimingInfo();
    return {
      label,
      fileCount: project.files.length,
      spawnAndSnapshotMs: t1 - t0,
      queryLoadMs: t2 - t1,
      contracts,
      requestCount: timing.totals.requestCount,
      roundTripMs: timing.totals.roundTripMs,
      serverTimeMs: timing.totals.serverTimeMs,
      bytes: timing.totals.bytesSent + timing.totals.bytesReceived,
      tscBaselineMs: baseline,
    };
  } finally {
    api.close();
  }
}

interface IncrementalResult {
  readonly rounds: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly requestsPerRound: number;
  readonly fullReopenP50Ms: number;
}

function incrementalRun(project: SyntheticProject, rounds: number): IncrementalResult {
  const api = new API({ cwd: project.root, collectTiming: true });
  try {
    let snapshot = api.updateSnapshot({ openProjects: [project.tsconfigPath] });
    const target = project.files[0];
    if (target === undefined) {
      throw new Error("empty project");
    }
    const samples: number[] = [];
    let requestsBefore = api.getTimingInfo().totals.requestCount;
    let requestsPerRound = 0;
    for (let round = 0; round < rounds; round += 1) {
      writeFileSync(target, `${roundSource(round)}`);
      const start = performance.now();
      const next = api.updateSnapshot({ fileChanges: { changed: [target] } });
      snapshot.dispose();
      snapshot = next;
      queryContractLoad(api, snapshot, project.tsconfigPath, [target], 1);
      samples.push(performance.now() - start);
      const requestsAfter = api.getTimingInfo().totals.requestCount;
      // getTimingInfo 自身也是一趟请求,扣除。
      requestsPerRound = requestsAfter - requestsBefore - 1;
      requestsBefore = requestsAfter;
    }
    snapshot.dispose();

    // 对照:每轮全新 spawn + 全量 snapshot 的成本。
    const reopenSamples: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const start = performance.now();
      const fresh = new API({ cwd: project.root });
      const freshSnapshot = fresh.updateSnapshot({ openProjects: [project.tsconfigPath] });
      queryContractLoad(fresh, freshSnapshot, project.tsconfigPath, [target], 1);
      reopenSamples.push(performance.now() - start);
      fresh.close();
    }
    return {
      rounds,
      p50Ms: median(samples),
      p95Ms: percentile(samples, 95),
      requestsPerRound,
      fullReopenP50Ms: median(reopenSamples),
    };
  } finally {
    api.close();
  }
}

function roundSource(round: number): string {
  return [
    `import type { Address1 } from "./contract1";`,
    "export interface User0 {",
    "  id: number;",
    "  name: string;",
    "  tags: readonly string[];",
    "  address: Address0;",
    "  neighbor: Address1 | null;",
    '  kind: "active" | "archived";',
    "  createdAt: Date;",
    `  round${round}: string;`,
    "}",
    "export interface Address0 {",
    "  city: string;",
    "  zip?: string;",
    "  next?: Address0;",
    "}",
    "",
  ].join("\n");
}

interface BatchResult {
  readonly positions: number;
  readonly singleCallsMs: number;
  readonly batchedCallMs: number;
  readonly propertiesFirstMs: number;
  readonly propertiesMemoizedMs: number;
  readonly perTripMs: number;
}

function batchRun(project: SyntheticProject): BatchResult {
  const api = new API({ cwd: project.root, collectTiming: true });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [project.tsconfigPath] });
    const checkerProject = snapshot.getProject(project.tsconfigPath);
    if (checkerProject === undefined) {
      throw new Error("project not loaded");
    }
    const checker = checkerProject.checker;
    const file = project.files[0];
    if (file === undefined) {
      throw new Error("empty project");
    }
    const positions = Array.from({ length: 64 }, (_value, index) => 60 + index);

    const t0 = performance.now();
    for (const position of positions) {
      checker.getTypeAtPosition(file, position);
    }
    const t1 = performance.now();
    checker.getTypeAtPosition(file, positions);
    const t2 = performance.now();

    // 均摊:大量小请求的单趟往返成本。
    const tripStart = api.getTimingInfo().totals;
    const tripT0 = performance.now();
    const trips = 500;
    for (let index = 0; index < trips; index += 1) {
      checker.getTypeAtPosition(file, 60);
    }
    const tripT1 = performance.now();
    const tripEnd = api.getTimingInfo().totals;

    // memoization:同一 Type 句柄重复展开,client 缓存 + server memoize。
    const interfaceOffset =
      readFileSync(file, "utf8").indexOf("export interface User") + "export interface ".length;
    const type = checker.getTypeAtPosition(file, interfaceOffset);
    if (type === undefined) {
      throw new Error("no type at interface position");
    }
    const m0 = performance.now();
    const properties = type.getProperties();
    checker.getTypeOfSymbol(properties);
    const m1 = performance.now();
    for (let index = 0; index < 100; index += 1) {
      const again = type.getProperties();
      checker.getTypeOfSymbol(again);
    }
    const m2 = performance.now();

    snapshot.dispose();
    return {
      positions: positions.length,
      singleCallsMs: t1 - t0,
      batchedCallMs: t2 - t1,
      propertiesFirstMs: m1 - m0,
      propertiesMemoizedMs: (m2 - m1) / 100,
      perTripMs: (tripT1 - tripT0) / Math.max(1, tripEnd.requestCount - tripStart.requestCount - 1),
    };
  } finally {
    api.close();
  }
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

const sizes = [500, 2000];
console.log("=== A. cold start (spawn + snapshot + contract query load) ===");
for (const size of sizes) {
  const project = generateProject(size);
  try {
    const result = coldRun(`synthetic-${size}`, project, 10);
    console.log(
      [
        result.label,
        `files=${result.fileCount}`,
        `tsc-baseline=${formatMs(result.tscBaselineMs)}`,
        `spawn+snapshot=${formatMs(result.spawnAndSnapshotMs)}`,
        `queries(${result.contracts} contracts)=${formatMs(result.queryLoadMs)}`,
        `requests=${result.requestCount}`,
        `roundTrip=${formatMs(result.roundTripMs)}`,
        `server=${formatMs(result.serverTimeMs)}`,
        `bytes=${result.bytes}`,
      ].join(" | "),
    );
  } finally {
    rmSync(project.root, { recursive: true, force: true });
  }
}
{
  const compilerTsconfig = path.join(packageRoot, "tsconfig.json");
  const baseline = tscBaselineMs(compilerTsconfig);
  const api = new API({ cwd: packageRoot, collectTiming: true });
  const t0 = performance.now();
  api.updateSnapshot({ openProjects: [compilerTsconfig] });
  const t1 = performance.now();
  console.log(
    `self(packages/devkit/compiler) | tsc-baseline=${formatMs(baseline)} | spawn+snapshot=${formatMs(t1 - t0)}`,
  );
  api.close();
}

console.log("=== B. dev-watch incremental (30 rounds, change one file) ===");
{
  const project = generateProject(500);
  try {
    const result = incrementalRun(project, 30);
    console.log(
      [
        `rounds=${result.rounds}`,
        `p50=${formatMs(result.p50Ms)}`,
        `p95=${formatMs(result.p95Ms)}`,
        `ipc-requests/round=${result.requestsPerRound}`,
        `full-reopen-p50=${formatMs(result.fullReopenP50Ms)}`,
      ].join(" | "),
    );
  } finally {
    rmSync(project.root, { recursive: true, force: true });
  }
}

console.log("=== C. batching and memoization ===");
{
  const project = generateProject(100);
  try {
    const result = batchRun(project);
    console.log(
      [
        `${result.positions} positions single=${formatMs(result.singleCallsMs)}`,
        `batched=${formatMs(result.batchedCallMs)}`,
        `per-trip=${result.perTripMs.toFixed(3)}ms`,
        `properties first=${formatMs(result.propertiesFirstMs)}`,
        `properties repeat=${result.propertiesMemoizedMs.toFixed(3)}ms`,
      ].join(" | "),
    );
  } finally {
    rmSync(project.root, { recursive: true, force: true });
  }
}
