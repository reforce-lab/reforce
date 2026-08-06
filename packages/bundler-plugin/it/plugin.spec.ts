import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTemporaryProject, type TemporaryProject } from "@reforce/tooling-testing";
import { createRslib, type RslibConfig } from "@rslib/core";
import { build } from "esbuild";
import { afterEach, expect, test } from "vitest";
import { reforceStarter } from "@/index";
import { reforceStarterRsbuild } from "@/rsbuild";

// 作者侧插件 IT（ADR 0004 决策 4，#120/#147）：收尾钩子跑库模式编译、meta 写作者配置的输出目录、
// 自动补/校正 exports 的 ./reforce-meta subpath、publint 兜发布事故。库模式编译语义由 compiler
// 的 library-compile IT 钉住，这里只验插件面。

const projects: TemporaryProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

interface LibraryOverrides {
  readonly packageJson?: Record<string, unknown>;
  readonly sources?: Record<string, string>;
}

async function createLibrary(overrides: LibraryOverrides = {}): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    "package.json": `${JSON.stringify({
      name: "@acme/starter-widget",
      version: "1.0.0",
      type: "module",
      files: ["dist"],
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      },
      ...overrides.packageJson,
    })}\n`,
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
      },
      include: ["src"],
    })}\n`,
    src: overrides.sources ?? {
      "index.ts": [
        'import { Injectable } from "@reforce/context";',
        "",
        "@Injectable()",
        "export class Widget {}",
        "",
      ].join("\n"),
    },
    dist: {
      "index.d.ts": "export declare class Widget {}\n",
      "index.js": "export class Widget {}\n",
    },
  });
  projects.push(project);
  return project;
}

function writeBundleHook(options: Parameters<typeof reforceStarter.raw>[0]): () => Promise<void> {
  const raw = reforceStarter.raw(options, { framework: "rollup" });
  const plugin = Array.isArray(raw) ? raw[0] : raw;
  const hook = plugin?.writeBundle;
  if (hook === undefined) {
    throw new Error("reforce-starter must register a writeBundle hook");
  }
  return async () => {
    await hook();
  };
}

test("writeBundle compiles meta into the output directory and patches exports", async () => {
  const project = await createLibrary();
  const finish = writeBundleHook({ projectDirectory: project.projectRoot, publint: false });

  await finish();

  const meta = JSON.parse(
    await readFile(join(project.projectRoot, "dist", "reforce-meta.json"), "utf8"),
  );
  expect(meta.schemaVersion).toBe(1);
  expect(meta.beans.map((bean: { id: string }) => bean.id)).toEqual([
    "@acme/starter-widget#Widget",
  ]);
  const packageJson = JSON.parse(await readFile(join(project.projectRoot, "package.json"), "utf8"));
  expect(packageJson.exports["./reforce-meta"]).toBe("./dist/reforce-meta.json");
});

test("writeBundle keeps an already-correct package.json byte-identical", async () => {
  const project = await createLibrary();
  const finish = writeBundleHook({ projectDirectory: project.projectRoot, publint: false });
  await finish();
  const firstPass = await readFile(join(project.projectRoot, "package.json"), "utf8");

  await finish();

  expect(await readFile(join(project.projectRoot, "package.json"), "utf8")).toBe(firstPass);
});

test("writeBundle honors a custom output directory", async () => {
  const project = await createLibrary();
  const finish = writeBundleHook({
    projectDirectory: project.projectRoot,
    outputDirectory: "build",
    publint: false,
  });

  await finish();

  const meta = JSON.parse(
    await readFile(join(project.projectRoot, "build", "reforce-meta.json"), "utf8"),
  );
  expect(meta.schemaVersion).toBe(1);
  const packageJson = JSON.parse(await readFile(join(project.projectRoot, "package.json"), "utf8"));
  expect(packageJson.exports["./reforce-meta"]).toBe("./build/reforce-meta.json");
});

test("writeBundle surfaces compiler diagnostics as a build error", async () => {
  const project = await createLibrary({
    sources: {
      "index.ts": [
        'import { defineBean } from "@reforce/context";',
        "",
        "export const clock = defineBean({",
        "  create: () => ({ now: () => 0 }),",
        "});",
        "",
      ].join("\n"),
    },
  });
  const finish = writeBundleHook({ projectDirectory: project.projectRoot, publint: false });

  await expect(finish()).rejects.toThrow("UNSUPPORTED_LIBRARY_DECLARATION");
});

test("writeBundle fails on publint errors after patching exports", async () => {
  const project = await createLibrary({
    packageJson: { main: "./missing.js" },
  });
  const finish = writeBundleHook({ projectDirectory: project.projectRoot });

  await expect(finish()).rejects.toThrow("publint");
});

test("verify mode keeps a correct package.json byte-identical", async () => {
  const project = await createLibrary({
    packageJson: {
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./reforce-meta": "./dist/reforce-meta.json",
      },
    },
  });
  const original = await readFile(join(project.projectRoot, "package.json"), "utf8");
  const finish = writeBundleHook({
    projectDirectory: project.projectRoot,
    exports: "verify",
    publint: false,
  });

  await finish();

  expect(await readFile(join(project.projectRoot, "package.json"), "utf8")).toBe(original);
});

test("verify mode reports missing starter subpaths without rewriting package.json", async () => {
  const project = await createLibrary();
  const original = await readFile(join(project.projectRoot, "package.json"), "utf8");
  const finish = writeBundleHook({
    projectDirectory: project.projectRoot,
    exports: "verify",
    publint: false,
  });

  await expect(finish()).rejects.toThrow(
    'exports must map "./reforce-meta" to "./dist/reforce-meta.json"',
  );
  expect(await readFile(join(project.projectRoot, "package.json"), "utf8")).toBe(original);
});

// 真实 rslib 构建（dts 走 tsgo）的两个用例：rsbuild-plugin-dts 从项目根 resolve typescript
// 可执行文件，tsgo 又要解析 @reforce/context 的类型，所以两个包都要在临时项目内可解析。
// @reforce/context 按安装形态以 junction 链接（Windows 无需符号链接权限）。
function installedPackageRoot(specifier: string): string {
  return dirname(dirname(fileURLToPath(import.meta.resolve(specifier))));
}

async function linkIntoProject(projectRoot: string, packageName: string): Promise<void> {
  const destination = join(projectRoot, "node_modules", ...packageName.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await symlink(installedPackageRoot(packageName), destination, "junction");
}

// typescript 不能直接链接真包：两侧插件面的断言都关于"d.ts 落盘相对 rspack afterEmit 的先后"，
// 真 tsgo 的落盘时点随机器快慢漂移——macOS CI 上曾赶在 afterEmit 之前完成，令"unplugin 面
// 必败"的断言假绿（#185）。这里装的 typescript 包版本同真；rsbuild-plugin-dts 在 fork 出的
// dts 子进程里以 `await import()` 拉取 lib/getExePath.js，假模块用顶层 await 先睡固定时长
// 再返回真 tsgo 可执行文件路径，把 d.ts 确定性推迟到 afterEmit 之后——全平台都不产生脚本
// wrapper spawn（Windows 上 .cmd wrapper 会被 Node ≥20.12 以 EINVAL 拒 spawn，#209）。
// 子进程退出时落 marker，供用例在临时树清理前等它退净（Windows 上活进程的 cwd 会挡住递归删除）。
const dtsDelayMilliseconds = 3000;
const delayedTsgoStartedMarker = "delayed-tsgo-started";
const delayedTsgoExitedMarker = "delayed-tsgo-exited";

async function readRealTypescriptVersion(realRoot: string): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(join(realRoot, "package.json"), "utf8"));
  const version =
    typeof parsed === "object" && parsed !== null && "version" in parsed
      ? parsed.version
      : undefined;
  if (typeof version !== "string") {
    throw new Error("The real typescript package must declare a version.");
  }
  return version;
}

async function resolveRealTsgoExecutable(realRoot: string): Promise<string> {
  const module: unknown = await import(pathToFileURL(join(realRoot, "lib", "getExePath.js")).href);
  const getExePath =
    typeof module === "object" && module !== null && "default" in module
      ? module.default
      : undefined;
  if (typeof getExePath !== "function") {
    throw new Error("typescript/lib/getExePath.js must default-export a function.");
  }
  const executable: unknown = getExePath();
  if (typeof executable !== "string") {
    throw new Error("getExePath must return the tsgo executable path.");
  }
  return executable;
}

async function installDelayedTypescript(projectRoot: string): Promise<void> {
  const realRoot = installedPackageRoot("typescript");
  const version = await readRealTypescriptVersion(realRoot);
  const realExecutable = await resolveRealTsgoExecutable(realRoot);
  const packageRoot = join(projectRoot, "node_modules", "typescript");
  await mkdir(join(packageRoot, "lib"), { recursive: true });
  const startedMarker = join(packageRoot, delayedTsgoStartedMarker);
  const exitedMarker = join(packageRoot, delayedTsgoExitedMarker);
  await Promise.all([
    writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({ name: "typescript", version, type: "module" })}\n`,
    ),
    writeFile(
      join(packageRoot, "lib", "getExePath.js"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(startedMarker)}, "started", "utf8");`,
        `process.on("exit", () => {`,
        `  writeFileSync(${JSON.stringify(exitedMarker)}, "done", "utf8");`,
        "});",
        `await new Promise((resolve) => setTimeout(resolve, ${dtsDelayMilliseconds}));`,
        "export default function getExePath() {",
        `  return ${JSON.stringify(realExecutable)};`,
        "}",
        "",
      ].join("\n"),
    ),
  ]);
}

async function waitForMarker(marker: string, deadline: number): Promise<boolean> {
  while (!existsSync(marker)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

async function waitForDelayedTsgoExit(projectRoot: string): Promise<void> {
  const packageRoot = join(projectRoot, "node_modules", "typescript");
  // 失败的构建可能根本没走到 dts spawn：包装进程 2 秒内没报到就当没启动，直接放行清理。
  const started = await waitForMarker(
    join(packageRoot, delayedTsgoStartedMarker),
    Date.now() + 2000,
  );
  if (!started) {
    return;
  }
  const exited = await waitForMarker(
    join(packageRoot, delayedTsgoExitedMarker),
    Date.now() + 30_000,
  );
  if (!exited) {
    throw new Error("Timed out waiting for the delayed tsgo wrapper to exit.");
  }
}

async function createRslibLibrary(): Promise<TemporaryProject> {
  const project = await createTemporaryProject({
    "package.json": `${JSON.stringify({
      name: "@acme/starter-widget",
      version: "1.0.0",
      type: "module",
      files: ["dist", "reforce-meta.json"],
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./reforce-meta": "./reforce-meta.json",
      },
    })}\n`,
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        moduleDetection: "force",
        lib: ["ESNext"],
        types: [],
        rootDir: "./src",
        strict: true,
        verbatimModuleSyntax: true,
        isolatedModules: true,
        skipLibCheck: true,
      },
      include: ["src"],
    })}\n`,
    src: {
      "index.ts": [
        'import { Injectable } from "@reforce/context";',
        "",
        "@Injectable()",
        "export class Widget {}",
        "",
      ].join("\n"),
    },
  });
  projects.push(project);
  await installDelayedTypescript(project.projectRoot);
  await linkIntoProject(project.projectRoot, "@reforce/context");
  return project;
}

// 与 tooling-rslib 基线同形（bundleless + tsgo dts），不经 defineLibraryConfig：库作者项目
// 不在本仓库 workspace 内，基线里的 externalHelpers 会要求临时项目再装 @swc/helpers。
function rslibLibraryConfig(extra: Partial<RslibConfig> = {}): RslibConfig {
  return {
    lib: [{ id: "esm", bundle: false, dts: { tsgo: true }, format: "esm", syntax: "esnext" }],
    output: { target: "node" },
    ...extra,
  };
}

async function runRslibBuild(projectRoot: string, extra: Partial<RslibConfig> = {}): Promise<void> {
  const rslib = await createRslib({ cwd: projectRoot, config: rslibLibraryConfig(extra) });
  await rslib.build();
}

test("the unplugin rspack surface fails a real rslib build before tsgo declarations land", async () => {
  const project = await createRslibLibrary();

  // 收尾钩子在 afterEmit 抛 INVALID_LIBRARY_PACKAGE（d.ts 尚未落盘），但 rspack 对 hook 错误
  // 的渲染随环境改写 message（macOS CI 上只剩栈帧），所以断言行为而非 message：构建失败且
  // meta 三件套没写出来；同一项目同一配置换 rsbuild 面即成功（下一个用例），失败纯因时序。
  try {
    await expect(
      runRslibBuild(project.projectRoot, {
        tools: {
          rspack: {
            plugins: [
              reforceStarter.rspack({
                projectDirectory: project.projectRoot,
                outputDirectory: ".",
                publint: false,
              }),
            ],
          },
        },
      }),
    ).rejects.toThrow();
    expect(existsSync(join(project.projectRoot, "reforce-meta.json"))).toBe(false);
  } finally {
    // 构建在 dts 落盘前就已失败返回，后台的延迟 tsgo 可能还活着——等它退净再进 afterEach
    // 清理（Windows 上活进程的 cwd 会挡住递归删除）。
    await waitForDelayedTsgoExit(project.projectRoot);
  }
}, 120_000);

test("the rsbuild surface finishes a real rslib build after tsgo declarations land", async () => {
  const project = await createRslibLibrary();

  await runRslibBuild(project.projectRoot, {
    plugins: [
      reforceStarterRsbuild({
        projectDirectory: project.projectRoot,
        tsconfigPath: "tsconfig.json",
        outputDirectory: ".",
        exports: "verify",
        publint: false,
      }),
    ],
  });

  const meta = JSON.parse(await readFile(join(project.projectRoot, "reforce-meta.json"), "utf8"));
  expect(meta.schemaVersion).toBe(1);
  expect(meta.beans.map((bean: { id: string }) => bean.id)).toEqual([
    "@acme/starter-widget#Widget",
  ]);
}, 120_000);

test("the esbuild adapter runs the finishing hook through esbuild's build API", async () => {
  const project = await createLibrary();

  await build({
    entryPoints: [join(project.projectRoot, "src", "index.ts")],
    outdir: join(project.projectRoot, "bundle"),
    bundle: true,
    platform: "node",
    external: ["@reforce/context"],
    plugins: [reforceStarter.esbuild({ projectDirectory: project.projectRoot, publint: false })],
  });

  const meta = JSON.parse(
    await readFile(join(project.projectRoot, "dist", "reforce-meta.json"), "utf8"),
  );
  expect(meta.schemaVersion).toBe(1);
});
