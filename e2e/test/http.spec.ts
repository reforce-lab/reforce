import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyApplicationProject,
  createTemporaryProject,
  resolveNodeExecutable,
  runCommand,
  type TemporaryProject,
} from "@reforce/tooling-testing";
import { sleep } from "radashi";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { installApplicationPackages } from "../support/application-packages";

// HTTP 全链路 e2e（ADR 0006 / #153）：从构建产物起真实 Bun 服务、打真实端口。覆盖面即
// #153 验收清单——路由命中与 404（未命中与方法不符同待遇）、洋葱顺序与 guard 短路、marker 元数据、请求校验
// 错误形态、codec 双向、响应白名单、并发请求作用域隔离、错误处理器兜底、优雅关闭排空。
// 服务就绪信号 = 引擎监听日志（ready 文件写在 onContextStart，早于 listen，不可用作 HTTP 就绪）。

const e2eRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliEntry = join(workspaceRoot, "packages", "cli", "dist", "reforce.js");
const applicationFixture = join(e2eRoot, "fixtures", "application");
const commandTimeout = 120_000;
const nodeExecutable = await resolveNodeExecutable();

interface StartedServer {
  readonly child: ChildProcess;
  readonly completion: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  readonly baseUrl: string;
  readonly output: () => string;
}

let project: TemporaryProject | undefined;

beforeAll(async () => {
  project = await createTemporaryProject();
  await copyApplicationProject(applicationFixture, project.projectRoot);
  await installApplicationPackages(project.projectRoot);
  const build = await runCommand(nodeExecutable, [cliEntry, "build", "--project", "."], {
    cwd: project.projectRoot,
    timeout: commandTimeout,
  });
  if (build.exitCode !== 0) {
    throw new Error(`fixture build failed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`);
  }
}, commandTimeout);

afterAll(async () => {
  await project?.cleanup();
});

function projectRoot(): string {
  if (project === undefined) {
    throw new Error("HTTP fixture project has not been built.");
  }
  return project.projectRoot;
}

async function startServer(): Promise<StartedServer> {
  const child = spawn(nodeExecutable, [cliEntry, "start", "--project", "."], {
    cwd: projectRoot(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const completion = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    },
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    // 监听行从三个引擎各自的裸 stderr 收回启动摘要（RFC 0011 L6/D2，#250），所以这里抓的是
    // 摘要那条 JSON 记录里的 fact，不再是 `[reforce.web-node] …` 前缀。`[^"\s]` 而不是 `[^\s]`：
    // 在 JSON 里 URL 后面紧跟的是引号，不是空白。
    const match = stderr.match(/listening on (http:\/\/[^"\s]+)\//);
    if (match?.[1] !== undefined) {
      return { child, completion, baseUrl: match[1], output: () => `${stdout}\n${stderr}` };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server exited before listening.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    if (Date.now() >= deadline) {
      child.kill("SIGKILL");
      throw new Error(`Timed out waiting for listen log.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    await sleep(20);
  }
}

async function shutdownServer(server: StartedServer): Promise<number | null> {
  server.child.send({ type: "reforce:shutdown", requestId: randomUUID() });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      server.completion,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for graceful exit.\n${server.output()}`)),
          30_000,
        );
      }),
    ]);
    return outcome.exitCode;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function forceCleanup(server: StartedServer): void {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill("SIGKILL");
  }
}

async function withServer(run: (baseUrl: string, server: StartedServer) => Promise<void>) {
  const server = await startServer();
  try {
    await run(server.baseUrl, server);
    expect(await shutdownServer(server)).toBe(0);
  } finally {
    forceCleanup(server);
  }
}

describe.sequential("HTTP application over the built artifact", () => {
  test("the request surface behaves per route table over one running server", async () => {
    await withServer(async (base) => {
      // 路由命中 + 参数 codec 双向（线上 string → handler bigint → 线上 string）+ 洋葱顺序
      const shown = await fetch(`${base}/users/42`, {
        headers: { "x-user": "amy" },
      });
      expect(shown.status).toBe(200);
      expect(await shown.json()).toEqual({ id: "42", name: "user-42" });
      // 内层的后相先 append：头的值就是 内→外 的洋葱执行顺序
      expect(shown.headers.get("x-onion")).toBe("application, admission, observability");

      // marker 驱动的 guard 短路：@Roles 路由缺 x-user → 403，且短路层之内的中间件不再执行
      const denied = await fetch(`${base}/users/42`);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "forbidden", roles: ["admin"] });
      expect(denied.headers.get("x-onion")).toBe("observability");

      // 非法参数：codec 校验失败 → 框架 400 形态（脱敏 issues）
      const badParams = await fetch(`${base}/users/not-a-number`, {
        headers: { "x-user": "amy" },
      });
      expect(badParams.status).toBe(400);
      expect(await badParams.json()).toEqual({
        error: "request validation failed",
        source: "params",
        issues: [{ message: "id must be a numeric string", path: ["id"] }],
      });

      // body 校验失败形态
      const badBody = await fetch(`${base}/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(badBody.status).toBe(400);
      expect(await badBody.json()).toEqual({
        error: "request validation failed",
        source: "body",
        issues: [{ message: "name must be a non-empty string", path: ["name"] }],
      });

      // 响应字段白名单：handler 故意返回 secret，线上形状不得包含
      const created = await fetch(`${base}/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "amy" }),
      });
      expect(created.status).toBe(200);
      expect(await created.json()).toEqual({ id: "created", name: "amy" });

      // 方法级织入（ADR 0008 AM1，#202）：dist-only 链路里 $Woven 生效——拦截器把标记
      // 字面量 append 进被织方法的返回轨迹，响应即织入证据
      const woven = await fetch(`${base}/woven`);
      expect(woven.status).toBe(200);
      expect(await woven.json()).toEqual({ trail: ["service", "audited:report"] });

      // 静态路径路由与 404 冷路径：未命中与方法不符都是裸 404，不带 Allow
      // （WebEngineAdapter 契约）。OPTIONS 预检因此归引擎生态的 cors 中间件。
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.text()).toBe("ok");
      expect((await fetch(`${base}/nowhere`)).status).toBe(404);
      const wrongMethod = await fetch(`${base}/health`, { method: "DELETE" });
      expect(wrongMethod.status).toBe(404);
      expect(wrongMethod.headers.get("allow")).toBeNull();

      // 错误处理器接管与框架默认兜底
      const teapot = await fetch(`${base}/boom/teapot`);
      expect(teapot.status).toBe(418);
      expect(await teapot.text()).toBe("teapot");
      // C1（#250）：兜底 500 带 errorId，栈绝不进响应体。
      const unhandled = await fetch(`${base}/boom/unhandled`);
      expect(unhandled.status).toBe(500);
      expect(await unhandled.json()).toEqual({
        error: "internal",
        errorId: expect.any(String),
      });
    });
  });

  test("concurrent requests keep their own request scope", async () => {
    await withServer(async (base) => {
      const ids = Array.from({ length: 16 }, (_, index) => `request-${index}`);
      const responses = await Promise.all(
        ids.map(async (id) => {
          const response = await fetch(`${base}/audit?delay=100`, {
            headers: { "x-request-id": id },
          });
          expect(response.status).toBe(200);
          return (await response.json()) as { id: string; path: string };
        }),
      );

      expect(responses.map((body) => body.id)).toEqual(ids);
      expect(new Set(responses.map((body) => body.path))).toEqual(new Set(["/audit"]));
    });
  });

  test("graceful shutdown drains the in-flight request before the process exits", async () => {
    const server = await startServer();
    try {
      const inflight = fetch(`${server.baseUrl}/audit?delay=1500`, {
        headers: { "x-request-id": "draining" },
      });
      // 等请求进入 handler（listen 已就绪，100ms 足够本机回环建立连接）
      await sleep(100);
      const exitCode = shutdownServer(server);

      const response = await inflight;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: "draining", path: "/audit" });
      expect(await exitCode).toBe(0);

      // 排空完成后进程已退出，新连接必须被拒绝
      await expect(fetch(`${server.baseUrl}/health`)).rejects.toThrow();
    } finally {
      forceCleanup(server);
    }
  });
});
