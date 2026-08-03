import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCompiler } from "@reforce/compiler";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { startDevWatchBuild } from "@/bundling/dev-watch";
import { DevCompilerGate } from "@/dev/compiler-gate";
import type { DevCompilation } from "@/dev/watch-coordinator";
import { DirectoryTransactions } from "@/project/directory-transaction";
import { ProjectLease } from "@/project/lease";

const workspaceRoot = resolve("../..");
const contextRoot = join(workspaceRoot, "packages", "context");
const radashiRoot = fileURLToPath(new URL("..", import.meta.resolve("radashi")));
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
  const watch = await startDevWatchBuild({
    project: resolution.project,
    gate,
    onCompilation,
    ...(onInvalidated ? { onInvalidated } : {}),
  });
  watches.push(watch);
  return project;
}

async function installContextDistribution(projectRoot: string): Promise<void> {
  const target = join(projectRoot, "node_modules", "@reforce", "context");
  await mkdir(target, { recursive: true });
  await Promise.all([
    cp(join(contextRoot, "package.json"), join(target, "package.json")),
    cp(join(contextRoot, "dist"), join(target, "dist"), { recursive: true }),
    cp(radashiRoot, join(projectRoot, "node_modules", "radashi"), { recursive: true }),
  ]);
}

// 编译到达本来就是个事件（onCompilation 回调），所以这里等的是事件而不是时钟：不再有
// 「轮询 + 写死预算」这一层。旧实现用 Date.now() + 10_000 判死，那个数按快平台标定，
// windows 上正常但偏慢的编译会被判成失败（Issue #57）。
//
// 唯一剩下的时钟是每条用例的预算，见 hangDetectionBudgetMilliseconds。
function recordCompilations(): {
  readonly all: readonly DevCompilation[];
  accept(compilation: DevCompilation): void;
  untilCount(count: number): Promise<void>;
} {
  const received: DevCompilation[] = [];
  const waiters = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  return {
    get all() {
      return received;
    },
    accept(compilation) {
      received.push(compilation);
      // 一次编译可能同时满足多个更小的门槛（例如 waiter 注册在 1，而这次直接到了 2）。
      for (const [threshold, waiter] of waiters) {
        if (received.length >= threshold) {
          waiter.resolve();
          waiters.delete(threshold);
        }
      }
    },
    async untilCount(count) {
      if (received.length >= count) {
        return;
      }
      const waiter = waiters.get(count) ?? Promise.withResolvers<void>();
      waiters.set(count, waiter);
      await waiter.promise;
    },
  };
}

// 与 it/recovery/directory-transaction.spec.ts 同一条规则（Issue #81）：墙钟预算的职责是抓
// 「卡死」而不是管「慢」。包级 --timeout 15000 是按快平台标定的，windows 上这些用例要起真实
// rspack watcher 并等文件系统事件，正常耗时就可能超过它。真正的时钟是 CI job 的
// timeout-minutes（Issue #75）。
const hangDetectionBudgetMilliseconds = 120_000;

test(
  "Rsbuild watch emits a Bun ESM entry after the compiler gate commits generated output",
  async () => {
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
  },
  hangDetectionBudgetMilliseconds,
);

test(
  "keeps the development entry source inside the build graph",
  async () => {
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
  },
  hangDetectionBudgetMilliseconds,
);

test(
  "Rsbuild watch emits source maps for the Bun ESM entry",
  async () => {
    const compiled = Promise.withResolvers<DevCompilation>();
    const project = await setupWatch(async (compilation) => compiled.resolve(compilation));

    const result = await compiled.promise;

    expect(result.status).toBe("success");
    expect(
      await readFile(join(project.projectRoot, ".reforce", "dev", "main.mjs.map"), "utf8"),
    ).toContain('"version":3');
  },
  hangDetectionBudgetMilliseconds,
);

test(
  "a source edit rebuilds once without a generated-output invalidation",
  async () => {
    const compilations = recordCompilations();
    const invalidations: Array<string | null> = [];
    const project = await setupWatch(
      async (compilation) => {
        compilations.accept(compilation);
      },
      (path) => invalidations.push(path),
    );
    await compilations.untilCount(1);

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
    await compilations.untilCount(2);
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    expect({
      statuses: compilations.all.map((compilation) => compilation.status),
      invalidations,
    }).toEqual({
      statuses: ["success", "success"],
      invalidations: [join(project.projectRoot, "src", "application.ts")],
    });
  },
  hangDetectionBudgetMilliseconds,
);

test(
  "an extended configuration outside projectRoot invalidates the application watch",
  async () => {
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
    const invalidations: Array<string | null> = [];
    const watch = await startDevWatchBuild({
      project: resolution.project,
      gate,
      onCompilation: async (compilation) => {
        compilations.accept(compilation);
      },
      onInvalidated: (path) => invalidations.push(path),
    });
    watches.push(watch);
    await compilations.untilCount(1);
    const sharedConfigPath = join(project.projectRoot, "tsconfig.shared.json");

    await writeFile(
      sharedConfigPath,
      `${JSON.stringify({
        ...sharedConfig,
        compilerOptions: { ...sharedConfig.compilerOptions, noImplicitOverride: true },
      })}\n`,
    );
    await compilations.untilCount(2);

    expect(invalidations).toContain(sharedConfigPath);
    expect(compilations.all.map((compilation) => compilation.status)).toEqual([
      "success",
      "success",
    ]);
  },
  hangDetectionBudgetMilliseconds,
);

test(
  "creating a source file rebuilds once and discovers its Bean",
  async () => {
    const compilations = recordCompilations();
    const project = await setupWatch(async (compilation) => {
      compilations.accept(compilation);
    });
    await compilations.untilCount(1);
    const createdSourcePath = join(project.projectRoot, "src", "created.ts");

    await writeFile(
      createdSourcePath,
      `import { Injectable } from "@reforce/context";

@Injectable()
export class CreatedService {}
`,
    );
    await compilations.untilCount(2);
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    expect(compilations.all.map((compilation) => compilation.status)).toEqual([
      "success",
      "success",
    ]);
    expect(
      await readFile(join(project.projectRoot, ".reforce", "generated", "beans.ts"), "utf8"),
    ).toContain("CreatedService");
  },
  hangDetectionBudgetMilliseconds,
);

test(
  "deleting a source file removes its Bean without watching generated output",
  async () => {
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

    const removedSourcePath = join(project.projectRoot, "src", "removable.ts");
    await rm(removedSourcePath);
    await compilations.untilCount(2);
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    expect(compilations.all.every((compilation) => compilation.status === "success")).toBe(true);
    expect(await readFile(generatedBeansPath, "utf8")).not.toContain("RemovableService");
    expect(invalidations).toContain(removedSourcePath);
    expect(
      invalidations.every(
        (path) => path === null || !path.startsWith(join(project.projectRoot, ".reforce")),
      ),
    ).toBe(true);
  },
  hangDetectionBudgetMilliseconds,
);
