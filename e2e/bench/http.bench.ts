// 基准 ①/③（#153）：裸 node:http 同逻辑手写版（天花板基线）vs Reforce 全链路（构建产物）。
// - /health：最小路由（静态路径、零 schema、仍走 作用域+全局中间件链）→ 框架税下限；
// - /users/:id：典型链路（三层洋葱 + marker 准入 + 参数 codec + 编码序列化）→ 基准 ③。
// 方法学：同机同 Node、两个目标都是独立子进程、逐个串行压测（互不抢核）；先预热再计时；
// 结果打印为 markdown 表。复跑：`pnpm --dir e2e run bench:http`。

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyApplicationProject,
  createTemporaryProject,
  resolveNodeExecutable,
  runCommand,
} from "@reforce/tooling-testing";
import { installApplicationPackages } from "../support/application-packages.ts";
import { formatRow, type LoadResult, runLoad } from "./load.ts";

const e2eRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliEntry = join(workspaceRoot, "packages", "cli", "dist", "reforce.js");
const applicationFixture = join(e2eRoot, "fixtures", "application");
const nodeExecutable = await resolveNodeExecutable();

const connections = 32;
const warmupMilliseconds = 2000;
const durationMilliseconds = 8000;

interface StartedTarget {
  readonly child: ChildProcess;
  readonly baseUrl: string;
}

async function waitForListen(child: ChildProcess, pattern: RegExp): Promise<string> {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const match = stderr.match(pattern);
    if (match?.[1] !== undefined) {
      return match[1];
    }
    if (child.exitCode !== null || Date.now() >= deadline) {
      throw new Error(`target did not start listening:\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startTarget(
  command: readonly string[],
  cwd: string,
  pattern: RegExp,
): Promise<StartedTarget> {
  const child = spawn(nodeExecutable, [...command], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env },
  });
  const url = await waitForListen(child, pattern);
  return { child, baseUrl: url.replace(/\/$/, "") };
}

async function measureTarget(baseUrl: string): Promise<Record<string, LoadResult>> {
  const health = await runLoad(`${baseUrl}/health`, {
    connections,
    warmupMilliseconds,
    durationMilliseconds,
  });
  const chain = await runLoad(`${baseUrl}/users/1234567890123456789`, {
    connections,
    warmupMilliseconds,
    durationMilliseconds,
    headers: { "x-user": "bench" },
  });
  return { health, chain };
}

console.error("[bench] building the fixture application...");
const project = await createTemporaryProject();
try {
  await copyApplicationProject(applicationFixture, project.projectRoot);
  await installApplicationPackages(project.projectRoot);
  const build = await runCommand(nodeExecutable, [cliEntry, "build", "--project", "."], {
    cwd: project.projectRoot,
    timeout: 120_000,
  });
  if (build.exitCode !== 0) {
    throw new Error(`fixture build failed:\n${build.stdout}\n${build.stderr}`);
  }

  console.error("[bench] measuring the bare node:http baseline...");
  const bare = await startTarget(
    [join(e2eRoot, "bench", "bare-server.ts")],
    project.projectRoot,
    /\[bare\] listening on (http:\/\/[^\s]+)/,
  );
  let bareResults: Record<string, LoadResult>;
  try {
    bareResults = await measureTarget(bare.baseUrl);
  } finally {
    bare.child.kill("SIGKILL");
  }

  console.error("[bench] measuring the Reforce production artifact...");
  const reforce = await startTarget(
    [join(project.projectRoot, "dist", "main.mjs")],
    project.projectRoot,
    /\[reforce\.web-node\] listening on (http:\/\/[^\s]+)/,
  );
  let reforceResults: Record<string, LoadResult>;
  try {
    reforceResults = await measureTarget(reforce.baseUrl);
  } finally {
    reforce.child.kill("SIGKILL");
  }

  const bareHealth = bareResults.health;
  const bareChain = bareResults.chain;
  const reforceHealth = reforceResults.health;
  const reforceChain = reforceResults.chain;
  if (
    bareHealth === undefined ||
    bareChain === undefined ||
    reforceHealth === undefined ||
    reforceChain === undefined
  ) {
    throw new Error("benchmark results are incomplete");
  }
  console.log(
    `Node.js ${process.version} · ${process.platform}-${process.arch} · connections=${connections} · warmup=${warmupMilliseconds}ms · duration=${durationMilliseconds}ms`,
  );
  console.log("");
  console.log("| target | throughput | p50 | p99 | failures |");
  console.log("| --- | --- | --- | --- | --- |");
  console.log(formatRow("bare node:http · GET /health", bareHealth));
  console.log(formatRow("Reforce · GET /health", reforceHealth, bareHealth));
  console.log(formatRow("bare node:http · GET /users/:id", bareChain));
  console.log(
    formatRow("Reforce · GET /users/:id (3 middleware + marker + codec)", reforceChain, bareChain),
  );
} finally {
  await project.cleanup();
}
