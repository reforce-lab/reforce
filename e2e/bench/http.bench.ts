// 基准 ①/③（#153）：裸 node:http 同逻辑手写版（天花板基线）vs Reforce 全链路（构建产物）。
// - /health：最小路由（静态路径、零 schema、仍走 作用域+全局中间件链）→ 框架税下限；
// - /users/:id：典型链路（三层洋葱 + marker 准入 + 参数 codec + 编码序列化）→ 基准 ③。
// 方法学：同机同 Node、两个目标都是独立子进程、逐个串行压测（互不抢核）；autocannon 发压、
// 先预热再计时（#338 换尺子，理由见 bench/load.ts）；被测进程的输出丢弃、发压进程全程不碰
// （#371，见 startTarget）；结果打印为 markdown 表。复跑：`pnpm --dir e2e run bench:http`。

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyApplicationProject,
  createTemporaryProject,
  resolveNodeExecutable,
  runCommand,
} from "@reforce/tooling-testing";
import { installApplicationPackages } from "../support/application-packages.ts";
import {
  calibrateGenerator,
  formatCalibration,
  formatRow,
  type GeneratorCalibration,
  type LoadResult,
  runLoad,
} from "./load.ts";

const e2eRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliEntry = join(workspaceRoot, "packages", "devkit", "cli", "dist", "reforce.js");
const applicationFixture = join(e2eRoot, "fixtures", "application");
const nodeExecutable = await resolveNodeExecutable();

const connections = 32;
const warmupMilliseconds = 2000;
const durationMilliseconds = 8000;

interface StartedTarget {
  readonly child: ChildProcess;
  readonly baseUrl: string;
}

// 端口由父进程先占后放，再经环境变量交给子进程；就绪判据是"这个端口能连上"。
//
// 换掉原来的"从日志文件里正则出监听地址"（#371）：那条路强制被测进程的 stderr 必须落到一个
// 父进程读得到的文件，而默认 logger 写的就是 stderr（default-logger.ts:39），于是压测期间
// 每条请求日志都被同步写进真实文件。实测同一个二进制，落 tmpfs 文件 41.36µs/请求、
// 落 /dev/null 20.55µs，而不打请求日志的目标两者无差（17.39 / 17.63）——也就是说测出来的
// "框架税"里有 20.8µs 是我们把 JSON 灌进文件系统的钱，且它随系统脏页状态在轮次间漂移
// （同一份代码两次整轮压测测到 21.85 与 40.93，各自轮内极差只有 ±1.2% / ±4.0%）。
// 对照组每请求根本不打日志，这笔钱只有我们付，横向比较因此不成立。
async function reservePort(): Promise<number> {
  const probe = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("failed to reserve a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function waitForPort(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`target exited with code ${child.exitCode} before listening`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`target did not start listening on port ${port} within 30s`);
    }
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (reachable) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// 被测进程的 stdout/stderr 一律丢弃，发压进程不经手（#338 → #371）。
//
// 最早这里是 `stdio: [..., "pipe"]` 加一个**从不摘除**的 data 监听器：压测全程由发压进程
// 逐块 toString() 再往一个 string 上 concat，8 秒 × 2 万 rps ≈ 16 万行访问日志。后果是发压器
// 和日志消费者成了同一个进程、抢同一个核，而且被测进程的日志成本被记到了发压侧。
// 换成 pipe + 空 drain 不解决（每块仍要一次读 + 一次分配），摘掉监听器更糟（管道写满 64KB
// 后子进程阻塞在 write 上，等于把被测服务端挂住）。#338 改成落文件解决了这一层，但落盘本身
// 又成了新的混淆项——见上面 reservePort 的说明。现在两头都不占：直接丢 /dev/null。
//
// 排查启动失败时置 BENCH_KEEP_LOGS=1，输出会落回 logPath。
const keepLogs = process.env.BENCH_KEEP_LOGS === "1";

async function startTarget(
  command: readonly string[],
  cwd: string,
  logPath: string,
  port: number,
  portVariable: string,
): Promise<StartedTarget> {
  const sink = openSync(keepLogs ? logPath : "/dev/null", "w");
  const child = spawn(nodeExecutable, [...command], {
    cwd,
    stdio: ["ignore", sink, sink],
    env: { ...process.env, [portVariable]: String(port) },
  });
  // 子进程已经拿到自己那份 fd，父进程这一份立刻关掉，免得测完还占着。
  closeSync(sink);
  await waitForPort(port, child);
  return { child, baseUrl: `http://127.0.0.1:${port}` };
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
    join(project.projectRoot, "bench-bare.log"),
    await reservePort(),
    "BARE_SERVER_PORT",
  );
  let bareResults: Record<string, LoadResult>;
  let calibration: GeneratorCalibration;
  try {
    // 校准打裸 node:http：它是本表最快的目标，发压侧真要撑不住也是先在这里露馅（#338）。
    console.error("[bench] calibrating the load generator against the fastest target...");
    calibration = await calibrateGenerator(`${bare.baseUrl}/health`, {
      connections,
      warmupMilliseconds,
      durationMilliseconds,
    });
    bareResults = await measureTarget(bare.baseUrl);
  } finally {
    bare.child.kill("SIGKILL");
  }

  console.error("[bench] measuring the Reforce production artifact...");
  const reforce = await startTarget(
    [join(project.projectRoot, "dist", "main.mjs")],
    project.projectRoot,
    join(project.projectRoot, "bench-reforce.log"),
    await reservePort(),
    // 夹具的 WebServerConfig 是 ConfigProperties("webServer", …)，端口经环境层进来。
    "WEB_SERVER_PORT",
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
  console.log(formatCalibration(calibration));
  console.log("");
  // µs/req = 1e6/吞吐，即饱和单线程服务端上的每请求成本，可以直接和微基准的 ns/op 对账。
  // spread = 该测量点各轮吞吐的极差占中位数的比例，也就是这次测量的噪声下限——比它小的
  // 改动，单看这张表得不出结论。p99 只印毫秒整数：autocannon 的延迟直方图存整数毫秒，
  // 亚毫秒段没有分辨率（见 load.ts）。
  console.log("| target | throughput | µs/req | spread | p99 | failures |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  console.log(formatRow("bare node:http · GET /health", bareHealth));
  console.log(formatRow("Reforce · GET /health", reforceHealth, bareHealth));
  console.log(formatRow("bare node:http · GET /users/:id", bareChain));
  console.log(
    formatRow("Reforce · GET /users/:id (3 middleware + marker + codec)", reforceChain, bareChain),
  );
} finally {
  await project.cleanup();
}
