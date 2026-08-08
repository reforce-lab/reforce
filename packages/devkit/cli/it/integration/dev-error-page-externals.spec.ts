import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createCompiler } from "@reforce/compiler";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { afterEach, expect, test } from "vitest";
import { startDevWatchBuild } from "@/bundling/dev-watch";
import { DevCompilerGate } from "@/dev/compiler-gate";
import type { DevCompilation } from "@/dev/watch-coordinator";
import { DirectoryTransactions } from "@/project/directory-transaction";
import { ProjectLease } from "@/project/lease";
import { installContextDistribution, installWebDistribution } from "../support/watch-harness";

// dev 错误页渲染器外置（#279，spike 转正）：dev 构建 autoExternal: false，一切都进 bundle，
// 唯独渲染器必须留在真实 node_modules——它运行时按 import.meta.url 相对路径读自己的模板
// 资产，打进 bundle 后这些路径必然落空。这里对真实 dev 产物验证两环：
// 1. 构建环：产物里渲染器落成 `module file://…` 外置 import，内部实现没有被打进来；
// 2. 运行环：产物里那个 file:// URL 在本机真实可加载、能渲染出带内联资产的 HTML 页。
// 完整的「HTTP 请求 → 错误页」行为由 @reforce/web-core 的 it/dev-error-page.spec.ts 从分派器
// 层面覆盖，两环拼起来即 spike 验证的整条链。

const execFileAsync = promisify(execFile);

const projects: TemporaryProject[] = [];
const leases: ProjectLease[] = [];
const watches: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const watch of watches.splice(0).reverse()) {
    await watch.close();
  }
  for (const lease of leases.splice(0).reverse()) {
    await lease.release();
  }
  for (const project of projects.splice(0).reverse()) {
    await project.cleanup();
  }
});

// 与 dev-watch-build.spec 的 setupWatch 同构，但项目 import @reforce/web-core：让 error-dispatch
// 连同 dev-error-page 异步 chunk 进入构建图，渲染器外置才有对象。
async function buildWebProject(): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        experimentalDecorators: false,
        emitDecoratorMetadata: false,
      },
      include: ["src", ".reforce/generated/**/*.d.ts"],
    })}\n`,
    src: {
      "application.ts": `import { Injectable } from "@reforce/core";
import { NotFoundError } from "@reforce/web-core";

@Injectable()
export class ApplicationService {
  missing(): never {
    throw new NotFoundError("nothing here");
  }
}
`,
    },
  });
  projects.push(project);
  await installContextDistribution(project.projectRoot);
  await installWebDistribution(project.projectRoot);
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: project.projectRoot });
  if (resolution.status === "failure") {
    throw new Error(resolution.diagnostics[0].message);
  }
  const lease = await ProjectLease.acquire({ projectRoot: project.projectRoot, mode: "writer" });
  leases.push(lease);
  const transactions = await DirectoryTransactions.create({
    projectRoot: project.projectRoot,
    lease,
  });
  const gate = new DevCompilerGate({
    compiler,
    projectDirectory: project.projectRoot,
    project: resolution.project,
    initialWatchInputs: resolution.watchInputs,
    generatedOutput: transactions,
  });
  const initial = await gate.initialize();
  if (initial.status !== "success") {
    throw new Error("Expected the initial compiler gate to succeed.");
  }
  const compiled = Promise.withResolvers<DevCompilation>();
  const watch = await startDevWatchBuild({
    project: resolution.project,
    gate,
    onCompilation: async (compilation) => compiled.resolve(compilation),
  });
  watches.push(watch);
  const result = await compiled.promise;
  if (result.status !== "success") {
    throw new Error("Expected the development build to succeed.");
  }
  return project;
}

async function devOutputSources(projectRoot: string): Promise<string> {
  const devOutputRoot = join(projectRoot, ".reforce", "dev");
  const files = (await readdir(devOutputRoot, { recursive: true })).filter((file) =>
    file.endsWith(".mjs"),
  );
  const contents = await Promise.all(
    files.map((file) => readFile(join(devOutputRoot, file), "utf8")),
  );
  return contents.join("\n");
}

const rendererUrlPattern = /(file:\/\/[^"']*youch[^"']*)/u;

test("the development bundle externalizes the error page renderer to a file URL", async () => {
  const project = await buildWebProject();

  const output = await devOutputSources(project.projectRoot);

  expect(output).toMatch(rendererUrlPattern);
  // 内部实现被打进来就说明外置没生效：哨兵词取渲染器的传递依赖名（同生产哨兵的纪律，
  // 不用会撞注释的裸名）。@speed-highlight 的类名前缀 shj- 是资产内联进 bundle 的标志。
  expect(output).not.toContain("@speed-highlight/core");
  expect(output).not.toContain("shj-syn");
});

test("the externalized renderer URL loads from the artifact and renders a page", async () => {
  const project = await buildWebProject();
  const output = await devOutputSources(project.projectRoot);
  const match = output.match(rendererUrlPattern);
  if (!match) {
    throw new Error("The development output does not carry the externalized renderer URL.");
  }

  // 产物里那串 URL 必须原样可加载：子进程 import 它并真渲染一页。资产（内联 style）与
  // nonce 一起断言，钉住「从真实 node_modules 读模板资产」这一外置动机本身。
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    [
      `const { Youch } = await import(${JSON.stringify(match[1])});`,
      'const html = await new Youch().toHTML(new Error("externalized render probe"), {',
      '  cspNonce: "probe-nonce",',
      "});",
      "process.stdout.write(",
      "  JSON.stringify({",
      '    hasMessage: html.includes("externalized render probe"),',
      '    hasStyle: html.includes("<style"),',
      '    hasNonce: html.includes("probe-nonce"),',
      "  }),",
      ");",
    ].join("\n"),
  ]);

  expect(JSON.parse(stdout)).toEqual({ hasMessage: true, hasStyle: true, hasNonce: true });
}, 60_000);
