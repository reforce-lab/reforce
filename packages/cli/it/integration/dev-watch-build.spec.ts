import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCompiler } from "@reforce/compiler";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { afterEach, expect, test } from "vitest";
import { startDevWatchBuild } from "@/bundling/dev-watch";
import { DevCompilerGate } from "@/dev/compiler-gate";
import type { DevCompilation } from "@/dev/watch-coordinator";
import { DirectoryTransactions } from "@/project/directory-transaction";
import { ProjectLease } from "@/project/lease";
import {
  developmentOutputContains,
  establishWatchDelivery,
  installContextDistribution,
  recordCompilations,
  recordInvalidations,
  untilObserved,
  watchesGeneratedOutput,
} from "../support/watch-harness";

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

async function setupWatch(
  onCompilation: (compilation: DevCompilation) => Promise<void>,
  onInvalidated?: (path: string | null) => void,
  sourceFiles: Readonly<Record<string, string>> = {
    "application.ts": `import { Injectable } from "@reforce/context";

@Injectable()
export class ApplicationService {}
`,
  },
): Promise<TemporaryProject> {
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
    src: sourceFiles,
  });
  projects.push(project);
  await installContextDistribution(project.projectRoot);
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
  const compilations = recordCompilations();
  const invalidations = recordInvalidations();
  const watch = await startDevWatchBuild({
    project: resolution.project,
    gate,
    onCompilation: async (compilation) => {
      compilations.accept(compilation);
      await onCompilation(compilation);
    },
    onInvalidated: (path) => {
      invalidations.accept(path);
      onInvalidated?.(path);
    },
  });
  watches.push(watch);
  const applicationSource = sourceFiles["application.ts"];
  if (applicationSource === undefined) {
    throw new Error("setupWatch requires an application.ts source for the delivery sentinel.");
  }
  // 用例的编辑必须发生在事件流已就绪之后，否则押注的是 macOS 的启动窗口而不是本包的
  // 重建逻辑（Issue #177）。
  await establishWatchDelivery({
    compilations,
    invalidations,
    sentinelPath: join(project.projectRoot, "src", "application.ts"),
    sentinelBaseContent: applicationSource,
  });
  return project;
}

// 每条用例的击杀钟统一由包级 `bun test --timeout` 提供，spec 里不再各自声明（Issue #92）。
// 预算语义是抓「卡死」不是管「慢」：按预期耗时标定的窗口在 windows 上会把「正常但偏慢」判成
// 失败（Issue #57、#81）；再往外一层的时钟是 CI job 的 timeout-minutes（Issue #75）。

test("Rsbuild watch emits a Bun ESM entry after the compiler gate commits generated output", async () => {
  const compiled = Promise.withResolvers<DevCompilation>();
  const project = await setupWatch(async (compilation) => compiled.resolve(compilation));

  const result = await compiled.promise;

  expect(result.status).toBe("success");
  // rspack must have rewritten the accepted request into a real module id. Leaving the raw
  // "reforce:application-bootstrap" specifier in the output keys _acceptedDependencies by a string
  // no dependency matches, which silently disables every hot update (Issue #46).
  const entrySource = await readFile(
    join(project.projectRoot, ".reforce", "dev", "main.mjs"),
    "utf8",
  );
  expect(entrySource).toContain('hot.accept("./.reforce/generated/bootstrap.ts"');
  expect(entrySource).not.toContain('accept("reforce:application-bootstrap")');
});

test("keeps the development entry source inside the build graph", async () => {
  const compiled = Promise.withResolvers<DevCompilation>();
  const project = await setupWatch(async (compilation) => compiled.resolve(compilation));

  const result = await compiled.promise;

  expect(result.status).toBe("success");
  expect((await readdir(join(project.projectRoot, ".reforce"))).sort()).toEqual([
    "dev",
    "generated",
    "lease",
    "transactions",
  ]);
});

test("Rsbuild watch emits source maps for the Bun ESM entry", async () => {
  const compiled = Promise.withResolvers<DevCompilation>();
  const project = await setupWatch(async (compilation) => compiled.resolve(compilation));

  const result = await compiled.promise;

  expect(result.status).toBe("success");
  expect(
    await readFile(join(project.projectRoot, ".reforce", "dev", "main.mjs.map"), "utf8"),
  ).toContain('"version":3');
});

// createDevBuildId 之所以能只认 rspack hash、不再自己按字节兜底，前提是真实 watch 路径上每次编译
// （首次和重建都算）都拿得到非空 compilation.hash。这条前提没有单测能覆盖——只有真的跑起 rspack
// watcher 才谈得上 hash（Issue #111）。
test("every development build identifies itself by the Rspack compilation hash", async () => {
  const compilations = recordCompilations();
  const project = await setupWatch(async (compilation) => {
    compilations.accept(compilation);
  });
  await compilations.untilCount(1);
  const devOutputRoot = join(project.projectRoot, ".reforce", "dev");

  await writeFile(
    join(project.projectRoot, "src", "application.ts"),
    `import { Injectable } from "@reforce/context";

@Injectable()
export class ApplicationService {
  value(): string {
    return "rebuilt";
  }
}
`,
  );
  await untilObserved(compilations, () => developmentOutputContains(devOutputRoot, "rebuilt"));

  const buildIds = compilations.all.map((compilation) =>
    compilation.status === "success" ? compilation.buildId : "<failed compilation>",
  );
  expect(buildIds.length).toBeGreaterThanOrEqual(2);
  expect(buildIds.filter((buildId) => !buildId.startsWith("rspack:"))).toEqual([]);
});

test("a source edit rebuilds without invalidating generated output", async () => {
  const compilations = recordCompilations();
  const invalidations: Array<string | null> = [];
  const project = await setupWatch(
    async (compilation) => {
      compilations.accept(compilation);
    },
    (path) => invalidations.push(path),
  );
  await compilations.untilCount(1);
  const devOutputRoot = join(project.projectRoot, ".reforce", "dev");

  await writeFile(
    join(project.projectRoot, "src", "application.ts"),
    `import { Injectable } from "@reforce/context";

@Injectable()
export class ApplicationService {
  value(): string {
    return "updated";
  }
}
`,
  );
  await untilObserved(compilations, () => developmentOutputContains(devOutputRoot, "updated"));

  // 「.reforce 未被 watch」是个否定命题，不能用「睡一个窗口再看」来证明（窗口短了漏检、长了
  // 拖慢，Issue #92）。改用事件序：生成产物的提交发生在上面那次重建完成之前，若 .reforce 真的
  // 被 watch，那次提交的失效必然先于「观察到效果之后才发起」的哨兵编辑进入列表。等哨兵效果
  // 到达后再检查列表，等价于证明窗口期已经完整过去，全程没有墙钟。
  await writeFile(
    join(project.projectRoot, "src", "application.ts"),
    `import { Injectable } from "@reforce/context";

@Injectable()
export class ApplicationService {
  value(): string {
    return "updated-sentinel";
  }
}
`,
  );
  await untilObserved(compilations, () =>
    developmentOutputContains(devOutputRoot, "updated-sentinel"),
  );

  expect(compilations.all.every((compilation) => compilation.status === "success")).toBe(true);
  expect(watchesGeneratedOutput(project.projectRoot, invalidations)).toBe(false);
});

test("an extended configuration outside projectRoot invalidates the application watch", async () => {
  const sharedConfig = {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      experimentalDecorators: false,
      emitDecoratorMetadata: false,
    },
  };
  const project = await createTemporaryProject({
    apps: {
      api: {
        src: {
          "application.ts": `import { Injectable } from "@reforce/context";

@Injectable()
export class ApplicationService {}
`,
        },
        "tsconfig.json": `${JSON.stringify({
          extends: "../../tsconfig.shared.json",
          include: ["src", ".reforce/generated/**/*.d.ts"],
        })}\n`,
      },
    },
    "tsconfig.shared.json": `${JSON.stringify(sharedConfig)}\n`,
  });
  projects.push(project);
  await installContextDistribution(project.projectRoot);
  const projectRoot = join(project.projectRoot, "apps", "api");
  const compiler = createCompiler();
  const resolution = await compiler.resolveProject({ projectDirectory: projectRoot });
  if (resolution.status === "failure") {
    throw new Error(resolution.diagnostics[0].message);
  }
  const lease = await ProjectLease.acquire({ projectRoot, mode: "writer" });
  leases.push(lease);
  const transactions = await DirectoryTransactions.create({ projectRoot, lease });
  const gate = new DevCompilerGate({
    compiler,
    projectDirectory: projectRoot,
    project: resolution.project,
    initialWatchInputs: resolution.watchInputs,
    generatedOutput: transactions,
  });
  await gate.initialize();
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
  // 哨兵走 src 文件即可：屏障返回时距所有 watcher 创建已过整个重建往返，远超 ≤10ms 的
  // 丢失窗口，监视 tsconfig.shared.json 的根目录 watcher 同样已就绪（Issue #177）。
  await establishWatchDelivery({
    compilations,
    invalidations,
    sentinelPath: join(projectRoot, "src", "application.ts"),
    sentinelBaseContent: `import { Injectable } from "@reforce/context";

@Injectable()
export class ApplicationService {}
`,
  });
  const sharedConfigPath = join(project.projectRoot, "tsconfig.shared.json");

  await writeFile(
    sharedConfigPath,
    `${JSON.stringify({
      ...sharedConfig,
      compilerOptions: { ...sharedConfig.compilerOptions, noImplicitOverride: true },
    })}\n`,
  );
  await untilObserved(compilations, async () => invalidations.all.includes(sharedConfigPath));

  expect(compilations.all.every((compilation) => compilation.status === "success")).toBe(true);
});

test("creating a source file rebuilds and discovers its Bean", async () => {
  const compilations = recordCompilations();
  const project = await setupWatch(async (compilation) => {
    compilations.accept(compilation);
  });
  await compilations.untilCount(1);
  const generatedBeansPath = join(project.projectRoot, ".reforce", "generated", "beans.ts");

  await writeFile(
    join(project.projectRoot, "src", "created.ts"),
    `import { Injectable } from "@reforce/context";

@Injectable()
export class CreatedService {}
`,
  );
  await untilObserved(compilations, async () =>
    (await readFile(generatedBeansPath, "utf8")).includes("CreatedService"),
  );

  expect(compilations.all.every((compilation) => compilation.status === "success")).toBe(true);
});

test("deleting a source file removes its Bean without watching generated output", async () => {
  const compilations = recordCompilations();
  const invalidations: Array<string | null> = [];
  const project = await setupWatch(
    async (compilation) => {
      compilations.accept(compilation);
    },
    (path) => invalidations.push(path),
    {
      "application.ts": `import { Injectable } from "@reforce/context";

@Injectable()
export class ApplicationService {}
`,
      "removable.ts": `import { Injectable } from "@reforce/context";

@Injectable()
export class RemovableService {}
`,
    },
  );
  await compilations.untilCount(1);
  const generatedBeansPath = join(project.projectRoot, ".reforce", "generated", "beans.ts");
  expect(await readFile(generatedBeansPath, "utf8")).toContain("RemovableService");

  await rm(join(project.projectRoot, "src", "removable.ts"));
  await untilObserved(
    compilations,
    async () => !(await readFile(generatedBeansPath, "utf8")).includes("RemovableService"),
  );

  // 与「a source edit ...」用例相同的事件序哨兵，代替墙钟窗口证明没有 .reforce 失效（Issue #92）。
  const devOutputRoot = join(project.projectRoot, ".reforce", "dev");
  await writeFile(
    join(project.projectRoot, "src", "application.ts"),
    `import { Injectable } from "@reforce/context";

@Injectable()
export class ApplicationService {
  value(): string {
    return "sentinel-after-delete";
  }
}
`,
  );
  await untilObserved(compilations, () =>
    developmentOutputContains(devOutputRoot, "sentinel-after-delete"),
  );

  expect(compilations.all.every((compilation) => compilation.status === "success")).toBe(true);
  expect(watchesGeneratedOutput(project.projectRoot, invalidations)).toBe(false);
});
