import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCompiler } from "@reforce/compiler";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { afterEach, expect, test } from "vitest";
import { startDevWatchBuild } from "@/bundling/dev-watch";
import { DevCompilerGate } from "@/dev/compiler-gate";
import { collectInstallSignalInputs } from "@/dev/install-signals";
import { DirectoryTransactions } from "@/project/directory-transaction";
import { ProjectLease } from "@/project/lease";
import {
  starterApplicationSources,
  starterMeta,
  starterName,
  writeStarterPackage,
} from "../support/starter-fixture";
import {
  type CompilationRecorder,
  establishWatchDelivery,
  installContextDistribution,
  recordCompilations,
  recordInvalidations,
  untilObserved,
} from "../support/watch-harness";

// ADR 0004（#120）决策 17、Issue #148：dev loop 三信号——应用 package.json 依赖增删、pnpm-lock.yaml
// install 收尾、已解析 starter meta 文件路径——都必须汇入既有的「重发现→重链接→重生成」路径。
// 断言全部走事件序（编译回调 + 产物效果），不使用墙钟窗口（Issue #92/#94）；等待的是「改动的
// 效果出现」而非「第几次编译」，以吞掉 watchpack 启动窗口的随机目录事件（Issue #86）。

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

interface SignalsWatch {
  readonly project: TemporaryProject;
  readonly compilations: CompilationRecorder;
  readonly invalidations: readonly (string | null)[];
  readonly initialStatus: "success" | "failure" | "error";
}

async function setupSignalsWatch(options: {
  readonly sources: Readonly<Record<string, string>>;
  readonly prepare?: (projectRoot: string) => Promise<void>;
}): Promise<SignalsWatch> {
  const project = await createTemporaryProject({
    "package.json": `${JSON.stringify({
      name: "signals-application",
      private: true,
      type: "module",
      dependencies: { [starterName]: "1.2.0" },
    })}\n`,
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        experimentalDecorators: false,
        emitDecoratorMetadata: false,
      },
      include: ["src", ".reforce/generated/**/*.ts"],
    })}\n`,
    src: options.sources,
  });
  projects.push(project);
  await installContextDistribution(project.projectRoot);
  await options.prepare?.(project.projectRoot);
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
    installSignalInputs: await collectInstallSignalInputs(project.projectRoot),
    generatedOutput: transactions,
  });
  const initial = await gate.initialize();
  const compilations = recordCompilations();
  const invalidations = recordInvalidations();
  const watch = await startDevWatchBuild({
    project: resolution.project,
    gate,
    onCompilation: async (compilation) => {
      compilations.accept(compilation);
    },
    onInvalidated: (path) => invalidations.accept(path),
  });
  watches.push(watch);
  const applicationSource = options.sources["application.ts"];
  if (applicationSource === undefined) {
    throw new Error(
      "setupSignalsWatch requires an application.ts source for the delivery sentinel.",
    );
  }
  // 哨兵是追加注释、不改语义，初始编译失败的项目（如 starter meta 未安装）同样适用：
  // 投递证据取 invalid 钩子，不依赖构建成败（Issue #177）。
  await establishWatchDelivery({
    compilations,
    invalidations,
    sentinelPath: join(project.projectRoot, "src", "application.ts"),
    sentinelBaseContent: applicationSource,
  });
  return { project, compilations, invalidations: invalidations.all, initialStatus: initial.status };
}

function generatedBeansPath(projectRoot: string): string {
  return join(projectRoot, ".reforce", "generated", "beans.ts");
}

// 产物在失败期间不存在、在提交期间可能是中间态：读不到一律当「还没出现」。
async function generatedBeansContain(projectRoot: string, marker: string): Promise<boolean> {
  const content = await readFile(generatedBeansPath(projectRoot), "utf8").catch(() => "");
  return content.includes(marker);
}

test("a pnpm-lock.yaml write after installing a registered starter recovers the failed watch", async () => {
  const { project, compilations, invalidations } = await setupSignalsWatch({
    sources: starterApplicationSources,
  });
  await compilations.untilCount(1);
  const firstCompilation = compilations.all[0];
  if (firstCompilation?.status !== "failure") {
    throw new Error("Expected the initial compilation to fail before the install completes");
  }
  expect(firstCompilation.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "STARTER_META_NOT_FOUND",
  );

  // 模拟 bun install：先落包内容（node_modules 期间为半成品、被 watch 排除，不触发任何重建），
  // 最后写 pnpm-lock.yaml 作为收尾信号——重发现必须由它触发。
  await writeStarterPackage(join(project.projectRoot, "node_modules", "@acme", "starter-redis"));
  const lockPath = join(project.projectRoot, "pnpm-lock.yaml");
  await writeFile(lockPath, '{"lockfileVersion": 1}\n');

  await untilObserved(compilations, () =>
    generatedBeansContain(project.projectRoot, "RedisClient"),
  );

  expect(invalidations).toContain(lockPath);
  expect(compilations.all.at(-1)?.status).toBe("success");
});

test("an application package.json edit invalidates the development watch", async () => {
  const { project, compilations, invalidations } = await setupSignalsWatch({
    sources: {
      "application.ts": [
        'import { Injectable } from "@reforce/core";',
        "",
        "@Injectable()",
        "export class ApplicationService {}",
        "",
      ].join("\n"),
    },
  });
  await compilations.untilCount(1);
  const packageJsonPath = join(project.projectRoot, "package.json");

  await writeFile(
    packageJsonPath,
    `${JSON.stringify({
      name: "signals-application",
      private: true,
      type: "module",
      dependencies: {},
    })}\n`,
  );
  await untilObserved(compilations, async () => invalidations.includes(packageJsonPath));

  expect(compilations.all.every((compilation) => compilation.status === "success")).toBe(true);
});

// workspace 本地联调：node_modules 里是指向包目录本体的符号链接，链接器解析出的 meta 路径是
// 真实路径（不含 node_modules 段），因此它本身就是 watch 输入——编辑 meta 必须触发重链接。
async function setupLinkedStarterWatch(): Promise<SignalsWatch & { metaPath: string }> {
  const linkedStarterDirectory = "linked-starter";
  const watch = await setupSignalsWatch({
    sources: starterApplicationSources,
    prepare: async (projectRoot) => {
      const packageRoot = join(projectRoot, linkedStarterDirectory);
      await writeStarterPackage(packageRoot);
      await mkdir(join(projectRoot, "node_modules", "@acme"), { recursive: true });
      await symlink(
        packageRoot,
        join(projectRoot, "node_modules", "@acme", "starter-redis"),
        "junction",
      );
    },
  });
  return {
    ...watch,
    metaPath: join(watch.project.projectRoot, linkedStarterDirectory, "reforce-meta.json"),
  };
}

test("editing a workspace-linked starter meta relinks and regenerates", async () => {
  const watch = await setupLinkedStarterWatch();
  expect(watch.initialStatus).toBe("success");
  await watch.compilations.untilCount(1);
  expect(await generatedBeansContain(watch.project.projectRoot, "RedisClient")).toBe(true);
  expect(await generatedBeansContain(watch.project.projectRoot, "MetricsPusher")).toBe(false);

  await writeFile(watch.metaPath, starterMeta({ withRootBean: true }));

  await untilObserved(watch.compilations, () =>
    generatedBeansContain(watch.project.projectRoot, "MetricsPusher"),
  );
  expect(watch.compilations.all.at(-1)?.status).toBe("success");
});

test("an invalid starter meta keeps the last generated output until repaired", async () => {
  const watch = await setupLinkedStarterWatch();
  expect(watch.initialStatus).toBe("success");
  await watch.compilations.untilCount(1);
  const healthyBeans = await readFile(generatedBeansPath(watch.project.projectRoot), "utf8");

  await writeFile(watch.metaPath, "{ not json\n");
  await untilObserved(watch.compilations, async () =>
    watch.compilations.all.some(
      (compilation) =>
        compilation.status === "failure" &&
        compilation.diagnostics.some((diagnostic) => diagnostic.code === "INVALID_STARTER_META"),
    ),
  );
  // 失败期间生成物必须保持上一次健康状态（重链接失败保旧，ADR 0004 决策 17）。
  expect(await readFile(generatedBeansPath(watch.project.projectRoot), "utf8")).toBe(healthyBeans);

  // 修复即恢复；等到修复效果出现，同时证明失败窗口已完整过去（事件序哨兵，Issue #92）。
  await writeFile(watch.metaPath, starterMeta({ withRootBean: true }));
  await untilObserved(watch.compilations, () =>
    generatedBeansContain(watch.project.projectRoot, "MetricsPusher"),
  );
});
