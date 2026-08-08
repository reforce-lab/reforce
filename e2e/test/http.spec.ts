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
const cliEntry = join(workspaceRoot, "packages", "devkit", "cli", "dist", "reforce.js");
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
      expect(badParams.headers.get("content-type")).toContain("application/problem+json");
      expect(await badParams.json()).toEqual({
        type: "about:blank",
        title: "Bad Request",
        status: 400,
        code: "REQUEST_VALIDATION_FAILED",
        source: "params",
        issues: [{ message: "id must be a numeric string", path: ["id"] }],
      });

      // body 校验失败形态:多字段契约一次收齐全部 issues(缺字段/坏字段同错)
      const badBody = await fetch(`${base}/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(badBody.status).toBe(400);
      expect(await badBody.json()).toEqual({
        type: "about:blank",
        title: "Bad Request",
        status: 400,
        code: "REQUEST_VALIDATION_FAILED",
        source: "body",
        issues: [
          { message: "name must be a non-empty string", path: ["name"] },
          { message: "age must be an integer", path: ["age"] },
        ],
      });

      // 响应字段白名单：handler 故意返回 secret，线上形状不得包含
      const created = await fetch(`${base}/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "amy", age: 30 }),
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
        type: "about:blank",
        title: "Internal Server Error",
        status: 500,
        errorId: expect.any(String),
      });

      // 决议 6/7（#294）：用户抛的 HttpError 不经任何 handler，直接成为它自己状态码的
      // problem+json；用户自己起的 code 原样进扩展成员。dist-only 链路的证据。
      const conflict = await fetch(`${base}/boom/conflict`);
      expect(conflict.status).toBe(409);
      expect(conflict.headers.get("content-type")).toContain("application/problem+json");
      expect(await conflict.json()).toEqual({
        type: "about:blank",
        title: "Conflict",
        status: 409,
        detail: "greeting Lynch already exists",
        code: "GREETING_ALREADY_EXISTS",
      });
    });
  });

  // S3 响应侧验收清单(RFC 0012 S3,#275):推导/降级/状态码/响应 schema/@Throws/标量坑,
  // 一台服务器跑完。
  test("the S3 response surface behaves per declaration over one running server", async () => {
    await withServer(async (base) => {
      // 无标注干净推导:契约与显式标注一致,bigint 照常归一成字符串
      const inferred = await fetch(`${base}/orders/inferred`);
      expect(inferred.status).toBe(200);
      expect(await inferred.json()).toEqual({ id: "7", name: "inferred" });

      // 无标注推导失败 → free-form:返回值原样序列化,字节级断言(不投影不白名单)
      const loose = await fetch(`${base}/orders/loose`);
      expect(loose.status).toBe(200);
      expect(await loose.text()).toBe('{"raw":1,"nested":{"keep":true}}');

      // 单键 Param 写法:线上 string → handler bigint → 线上 string
      const byId = await fetch(`${base}/orders/42`);
      expect(await byId.json()).toEqual({ orderId: "42" });

      // Query 整契约形态:page 解码 number,tag 走 getAll 语义
      const search = await fetch(`${base}/orders/search?page=2&tag=a&tag=b`);
      expect(await search.json()).toEqual({ page: 2, tags: ["a", "b"] });

      // @ResponseStatus(201) + Headers 槽 + 用户 Set-Cookie:分条可取,body 走白名单投影
      const created = await fetch(`${base}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "amy", age: 30 }),
      });
      expect(created.status).toBe(201);
      expect(created.headers.getSetCookie()).toEqual([
        "order=amy; Path=/; HttpOnly",
        "session=abc; Path=/; HttpOnly",
      ]);
      expect(await created.json()).toEqual({ name: "amy" });

      // 响应契约两种写法线上产出一致:返回类型自映射 vs @ResponseSchema + 域对象直返
      const wireTyped = await fetch(`${base}/orders/wire-typed`);
      const wireSchema = await fetch(`${base}/orders/wire-schema`);
      const typedBytes = await wireTyped.text();
      expect(typedBytes).toBe('{"id":"42","total":10}');
      expect(await wireSchema.text()).toBe(typedBytes);

      // 三层嵌套深处的多余字段不出线
      const nested = await fetch(`${base}/orders/nested`);
      expect(await nested.text()).toBe('{"level1":{"level2":{"keep":"yes"}}}');

      // @Throws 链路:状态码与 body 按类型化处理器声明,bigint 经编码器归一
      const rejected = await fetch(`${base}/orders/checkout?fail=order`);
      expect(rejected.status).toBe(409);
      expect(rejected.headers.get("content-type")).toBe("application/json");
      expect(await rejected.json()).toEqual({ code: "ORDER_REJECTED", orderId: "42" });
      const quota = await fetch(`${base}/orders/checkout?fail=quota`);
      expect(quota.status).toBe(429);
      expect(await quota.json()).toEqual({ code: "QUOTA_EXCEEDED" });
      expect((await fetch(`${base}/orders/checkout`)).status).toBe(200);
    });
  });

  test("scalar decoding rejects the classic traps and keeps bigint precision", async () => {
    await withServer(async (base) => {
      // 正向:指数计数法收下、bigint 超过 2^53 精度不丢、boolean 只认 true/false
      const good = await fetch(`${base}/orders/scalars?page=1e3&big=9007199254740993&flag=true`);
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual({ page: 1000, big: "9007199254740993", flag: true });

      // 负向:空串与 0x10 不是数字、bigint 拒小数、boolean 拒 "1"
      for (const query of ["page=", "page=0x10", "big=1.5", "flag=1"]) {
        const response = await fetch(`${base}/orders/scalars?${query}`);
        expect(response.status).toBe(400);
      }
    });
  });

  test("header slots read hyphenated and cookie keys case-insensitively", async () => {
    await withServer(async (base) => {
      const probed = await fetch(`${base}/orders/headers-probe`, {
        headers: { "X-Tenant-Id": "acme", cookie: "a=1; b=2" },
      });
      expect(await probed.json()).toEqual({ tenant: "acme", cookie: "a=1; b=2" });

      const missing = await fetch(`${base}/orders/headers-probe`);
      expect(await missing.json()).toEqual({ tenant: null, cookie: null });
    });
  });

  test("the request body ladder answers each malformed stage with its own 400", async () => {
    await withServer(async (base) => {
      const post = (init: RequestInit) => fetch(`${base}/users/echo`, { method: "POST", ...init });
      const issuesOf = async (response: Response): Promise<unknown> => {
        expect(response.status).toBe(400);
        const body = (await response.json()) as { issues: unknown };
        return body.issues;
      };

      // 空体/错 content-type/非法 JSON:严格读体层各自给明确文案
      expect(
        await issuesOf(await post({ headers: { "content-type": "application/json" } })),
      ).toEqual([{ message: "request body is empty" }]);
      expect(
        await issuesOf(await post({ headers: { "content-type": "text/plain" }, body: "name=amy" })),
      ).toEqual([{ message: "content-type must be application/json" }]);
      expect(
        await issuesOf(
          await post({ headers: { "content-type": "application/json" }, body: "{oops" }),
        ),
      ).toEqual([{ message: expect.stringContaining("request body is not valid JSON") }]);

      // 非对象根与缺字段:schema 一次收齐两个字段的 issues
      expect(
        await issuesOf(
          await post({ headers: { "content-type": "application/json" }, body: '"just-a-string"' }),
        ),
      ).toEqual([
        { message: "name must be a non-empty string", path: ["name"] },
        { message: "age must be an integer", path: ["age"] },
      ]);

      // 多余字段被 schema 输出丢掉:echo 路由回显解码产物,extra 不见
      const echoed = await post({
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "amy", age: 30, extra: "drop-me" }),
      });
      expect(echoed.status).toBe(200);
      expect(await echoed.json()).toEqual({ name: "amy", age: 30 });
    });
  });

  // L4 的完整用户链路（RFC 0011，#242 影响面：「@reforce/web-core：请求字段的 LogFieldSource
  // 实现」）。断言的是**应用自己**打的那条记录，不是框架发的请求日志——后者的 method/path
  // 是 web 核心直接写进去的，用它做断言证明不了贡献者接上没有。
  test("an application log written during a request carries that request's fields", async () => {
    await withServer(async (base, server) => {
      expect((await fetch(`${base}/field-source`)).status).toBe(200);
      // 记录是同步写出的，但落到父进程的 stderr 要过一次管道。
      await sleep(100);

      const handlerRecord = server
        .output()
        .split("\n")
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        })
        .find((record) => record.message === "handler ran");

      // probe 是调用点自己给的，method/path 两个字段没有一个是它传的：全部由贡献者补上。
      expect(handlerRecord).toMatchObject({
        probe: "field-source",
        method: "GET",
        path: "/field-source",
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
          // 合法客户端 id 原样回显在响应头(#303),并发下与各自请求一一对应。
          expect(response.headers.get("x-request-id")).toBe(id);
          return (await response.json()) as { id: string; path: string };
        }),
      );

      expect(responses.map((body) => body.id)).toEqual(ids);
      expect(new Set(responses.map((body) => body.path))).toEqual(new Set(["/audit"]));
    });
  });

  // request id 开箱件(#303):零配置默认开启——缺省生成 UUID 形,应用日志 ≡ 请求日志 ≡
  // 响应头三相等,500 路径 requestId 与 errorId 同录一条记录。夹具零改动。
  test("request ids stamp every response and join the application, request and error logs", async () => {
    await withServer(async (base, server) => {
      const generated = await fetch(`${base}/health`);
      expect(generated.headers.get("x-request-id")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      const probed = await fetch(`${base}/field-source`, {
        headers: { "x-request-id": "join-me" },
      });
      expect(probed.headers.get("x-request-id")).toBe("join-me");

      const failed = await fetch(`${base}/boom/unhandled`, {
        headers: { "x-request-id": "failing-request" },
      });
      expect(failed.status).toBe(500);
      expect(failed.headers.get("x-request-id")).toBe("failing-request");
      const failedBody = (await failed.json()) as { errorId: string };

      await sleep(100);
      const records = server
        .output()
        .split("\n")
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        });

      // 三相等:应用自己打的记录与框架请求日志携带同一个 id,而它就是响应头上的那个。
      const handlerRecord = records.find((record) => record.message === "handler ran");
      expect(handlerRecord).toMatchObject({ requestId: "join-me" });
      const requestRecord = records.find(
        (record) => record.message === "request" && record.path === "/field-source",
      );
      expect(requestRecord).toMatchObject({ requestId: "join-me" });

      // 双 id 关联:unhandled error 记录同时携带 requestId 与响应 body 里的 errorId。
      const errorRecord = records.find((record) => record.message === "unhandled error");
      expect(errorRecord).toMatchObject({
        requestId: "failing-request",
        errorId: failedBody.errorId,
      });
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
