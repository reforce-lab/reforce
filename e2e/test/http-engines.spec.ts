import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
import { afterAll, describe, expect, test } from "vitest";
import { installApplicationPackages } from "../support/application-packages";

// 「换引擎零改动」的证据（#238）：同一份 controller / middleware / schema / marker 在三个引擎
// 下各跑一遍，断言逐条相同。
//
// 换引擎实际要动的只有两处，都不在业务代码里：
//   1. src/application.ts —— defineApplication 注册哪个 starter
//   2. src/web-config.ts  —— config class 闭合哪个引擎的 settings 契约（ADR 0005 通道）
// 本 spec 就是把这两处做文本替换，其余文件一字不动。业务代码要是被迫改一行，这条断言就没了。
//
// 引擎无关的**协议**行为由 @reforce/web/conformance 在各引擎包里覆盖（假路由、真服务器）；
// 这里覆盖的是它到不了的那一半：真实编译产物、DI 图、洋葱链、codec、错误处理器、优雅关闭。

const e2eRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliEntry = join(workspaceRoot, "packages", "cli", "dist", "reforce.js");
const applicationFixture = join(e2eRoot, "fixtures", "application");
const commandTimeout = 180_000;
const nodeExecutable = await resolveNodeExecutable();

interface EngineCase {
  readonly name: string;
  /** node_modules 里的包名；web-node 已由 installApplicationPackages 默认装上。 */
  readonly packageName: string;
  /** settings 契约的导出名，web-config.ts 用它闭合。 */
  readonly settingsType: string;
  /** 引擎适配器的 name，启动摘要拿它当段落标签；用来等 HTTP 就绪。 */
  readonly engineName: string;
}

const engines: readonly EngineCase[] = [
  {
    name: "web-node",
    packageName: "@reforce/web-node",
    settingsType: "WebNodeServeSettings",
    engineName: "node",
  },
  {
    name: "web-hono",
    packageName: "@reforce/web-hono",
    settingsType: "WebHonoServeSettings",
    engineName: "hono",
  },
  {
    name: "web-fastify",
    packageName: "@reforce/web-fastify",
    settingsType: "WebFastifyServeSettings",
    engineName: "fastify",
  },
];

const projects: TemporaryProject[] = [];

afterAll(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

// 只替换引擎接线的两处；controller / middleware / schema / marker 全部原样。
async function retargetEngine(projectRoot: string, engine: EngineCase): Promise<void> {
  const applicationPath = join(projectRoot, "src", "application.ts");
  const application = await readFile(applicationPath, "utf8");
  await writeFile(applicationPath, application.replaceAll("@reforce/web-node", engine.packageName));
  const configPath = join(projectRoot, "src", "web-config.ts");
  const config = await readFile(configPath, "utf8");
  await writeFile(
    configPath,
    config
      .replaceAll("@reforce/web-node", engine.packageName)
      .replaceAll("WebNodeServeSettings", engine.settingsType),
  );
}

async function buildFor(engine: EngineCase): Promise<string> {
  const project = await createTemporaryProject();
  projects.push(project);
  await copyApplicationProject(applicationFixture, project.projectRoot);
  await retargetEngine(project.projectRoot, engine);
  await installApplicationPackages(project.projectRoot, "workspace", [
    ...(engine.name === "web-node" ? [] : [engine.name]),
  ]);
  const build = await runCommand(nodeExecutable, [cliEntry, "build", "--project", "."], {
    cwd: project.projectRoot,
    timeout: commandTimeout,
  });
  if (build.exitCode !== 0) {
    throw new Error(
      `${engine.name} fixture build failed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
    );
  }
  return project.projectRoot;
}

interface StartedServer {
  readonly child: ChildProcess;
  readonly completion: Promise<number | null>;
  readonly baseUrl: string;
  readonly output: () => string;
}

async function startServer(projectRoot: string, engine: EngineCase): Promise<StartedServer> {
  const child = spawn(nodeExecutable, [cliEntry, "start", "--project", "."], {
    cwd: projectRoot,
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
  const completion = new Promise<number | null>((resolve) => {
    child.on("exit", (exitCode) => resolve(exitCode));
  });
  // 就绪信号 = 启动摘要里那条监听行（ready 文件写在 onContextStart，早于 listen，不可用作
  // HTTP 就绪）。摘要按引擎名分段，所以这里按段落标签定位而不是此前的 `[reforce.web-*]` 前缀。
  const pattern = new RegExp(`"${engine.engineName}"[^\\n]*listening on (http://[^"\\s]+)/`);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const match = stderr.match(pattern);
    if (match?.[1] !== undefined) {
      return { child, completion, baseUrl: match[1], output: () => `${stdout}\n${stderr}` };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${engine.name} exited before listening.\n${stdout}\n${stderr}`);
    }
    if (Date.now() >= deadline) {
      child.kill("SIGKILL");
      throw new Error(`${engine.name} timed out waiting for listen log.\n${stdout}\n${stderr}`);
    }
    await sleep(20);
  }
}

async function shutdown(server: StartedServer): Promise<number | null> {
  server.child.send({ type: "reforce:shutdown", requestId: randomUUID() });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      server.completion,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for graceful exit.\n${server.output()}`)),
          30_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (server.child.exitCode === null && server.child.signalCode === null) {
      server.child.kill("SIGKILL");
    }
  }
}

describe.sequential("the same application behaves identically across engines", () => {
  for (const engine of engines) {
    test(
      `${engine.name} serves the fixture with unchanged business code`,
      async () => {
        const projectRoot = await buildFor(engine);
        const server = await startServer(projectRoot, engine);
        const base = server.baseUrl;

        // 路由命中 + 参数 codec 双向（线上 string → handler bigint → 线上 string）+ 洋葱顺序
        const shown = await fetch(`${base}/users/42`, { headers: { "x-user": "amy" } });
        expect(shown.status).toBe(200);
        expect(await shown.json()).toEqual({ id: "42", name: "user-42" });
        expect(shown.headers.get("x-onion")).toBe("application, admission, observability");

        // marker 驱动的 guard 短路：@Roles 路由缺 x-user → 403，短路层之内的中间件不再执行
        const denied = await fetch(`${base}/users/42`);
        expect(denied.status).toBe(403);
        expect(await denied.json()).toEqual({ error: "forbidden", roles: ["admin"] });
        expect(denied.headers.get("x-onion")).toBe("observability");

        // 校验失败的框架 400 形态（脱敏 issues）
        const badParams = await fetch(`${base}/users/not-a-number`, {
          headers: { "x-user": "amy" },
        });
        expect(badParams.status).toBe(400);
        expect(await badParams.json()).toEqual({
          type: "about:blank",
          title: "Bad Request",
          status: 400,
          code: "REQUEST_VALIDATION_FAILED",
          source: "params",
          issues: [{ message: "id must be a numeric string", path: ["id"] }],
        });

        // 静态路由 + 未命中与方法不符都是裸 404（WebEngineAdapter 契约）
        expect(await (await fetch(`${base}/health`)).text()).toBe("ok");
        expect((await fetch(`${base}/nowhere`)).status).toBe(404);
        const wrongMethod = await fetch(`${base}/health`, { method: "DELETE" });
        expect(wrongMethod.status).toBe(404);
        expect(wrongMethod.headers.get("allow")).toBeNull();

        // 错误处理器接管与框架默认兜底
        const teapot = await fetch(`${base}/boom/teapot`);
        expect(teapot.status).toBe(418);
        expect(await teapot.text()).toBe("teapot");
        expect((await fetch(`${base}/boom/unhandled`)).status).toBe(500);
        // HttpError 三引擎同形：状态码与 problem+json 都由框架统一渲染（#294）
        const conflict = await fetch(`${base}/boom/conflict`);
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({ code: "GREETING_ALREADY_EXISTS" });

        // 方法级织入（$Woven 在 dist-only 链路里生效）
        expect(await (await fetch(`${base}/woven`)).json()).toEqual({
          trail: ["service", "audited:report"],
        });

        // 优雅关闭：排空后正常退出
        expect(await shutdown(server)).toBe(0);

        // 未命中日志三引擎一致（RFC 0011 C7，#250）：404 从不进入引擎无关执行层，所以
        // 「谁来记、记成什么样」由核心统一决定，三个引擎只负责调它。path 是原始请求目标
        // 去掉 query，级别是 info（未命中不是应用出错，且级别完全由客户端说了算）。
        const misses = server
          .output()
          .split("\n")
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          })
          .filter((record) => record.message === "route not found");
        expect(misses).toContainEqual(
          expect.objectContaining({ level: "info", method: "GET", path: "/nowhere", status: 404 }),
        );
        expect(misses).toContainEqual(
          expect.objectContaining({ level: "info", method: "DELETE", path: "/health" }),
        );
      },
      commandTimeout,
    );
  }
});
