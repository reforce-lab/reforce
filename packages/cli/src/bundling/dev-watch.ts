import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { compareUtf16CodeUnits, toPortablePath } from "@reforce/primitives";
import {
  hotUpdateChunkFilename,
  hotUpdateDirectory,
  hotUpdateManifestFilename,
} from "@reforce/runtime/dev-hot-update";
import { createRsbuild, type Rspack, rspack } from "@rsbuild/core";
import { createDevBuildId, type DevBuildAsset } from "@/bundling/build-id";
import { renderDevelopmentEntry } from "@/bundling/dev-entry";
import { ReforceCompilerGatePlugin } from "@/bundling/dev-gate-plugin";
import { unwatchedDirectoryNames, waitForRspackWatcher } from "@/bundling/dev-watcher-ready";
import { resolveRuntimeEntryPath } from "@/bundling/runtime-locator";
import type { ResolvedProject } from "@/compiler-types";
import type { DevCompilerGate } from "@/dev/compiler-gate";
import type { DevCompilation } from "@/dev/watch-coordinator";

export interface DevWatchBuild {
  close(): Promise<void>;
}

export interface StartDevWatchBuildOptions {
  readonly project: ResolvedProject;
  readonly gate: DevCompilerGate;
  readonly onCompilation: (compilation: DevCompilation) => Promise<void>;
  readonly onInvalidated?: (path: string | null) => void;
}

function assetRole(path: string): DevBuildAsset["role"] {
  if (path === "main.mjs") {
    return "entry";
  }
  if (path.endsWith(".map")) {
    return "source-map";
  }
  if (path.includes("hot-update") || path.startsWith(hotUpdateDirectory)) {
    return "hot-update";
  }
  return "chunk";
}

async function collectAssets(root: string, directory = root): Promise<readonly DevBuildAsset[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  const assets: DevBuildAsset[] = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Development output cannot contain a symbolic link: ${absolutePath}`);
    }
    if (entry.isDirectory()) {
      assets.push(...(await collectAssets(root, absolutePath)));
      continue;
    }
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile()) {
      throw new Error(`Development output must contain ordinary files: ${absolutePath}`);
    }
    const path = toPortablePath(relative(root, absolutePath));
    assets.push({ path, role: assetRole(path) });
  }
  return assets.sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
}

function statsItems(stats: Rspack.Stats | Rspack.MultiStats): readonly Rspack.Stats[] {
  return stats instanceof rspack.MultiStats ? stats.stats : [stats];
}

function statsError(stats: Rspack.Stats | Rspack.MultiStats): Error | undefined {
  if (!stats.hasErrors()) {
    return undefined;
  }
  return new Error(
    statsItems(stats)
      .map((item) => item.toString({ all: false, errors: true }))
      .join("\n"),
  );
}

function statsHash(stats: Rspack.Stats | Rspack.MultiStats): string | undefined {
  const hashes = statsItems(stats)
    .map((item) => item.compilation.hash)
    .filter((hash) => typeof hash === "string" && hash.length > 0);
  return hashes.length === 0 ? undefined : hashes.join(":");
}

function createDevWatchBuild(
  build: DevWatchBuild,
  compiler: Rspack.Compiler | undefined,
): DevWatchBuild {
  let closePromise: Promise<void> | undefined;
  return {
    close() {
      closePromise ??= Promise.resolve().then(() => {
        compiler?.watching?.suspend();
        return build.close();
      });
      return closePromise;
    },
  };
}

export async function startDevWatchBuild(
  options: StartDevWatchBuildOptions,
): Promise<DevWatchBuild> {
  const { projectRoot } = options.project;
  const virtualEntryPath = join(projectRoot, ".reforce", "virtual", "dev-entry.mjs");
  const devOutputRoot = join(projectRoot, ".reforce", "dev");
  const generatedBootstrapPath = join(projectRoot, ".reforce", "generated", "bootstrap.ts");
  const generatedBeansPath = join(projectRoot, ".reforce", "generated", "beans.ts");
  const devRuntimePath = resolveRuntimeEntryPath("dev-runtime");
  const gatePlugin = new ReforceCompilerGatePlugin(options.gate, [
    generatedBootstrapPath,
    generatedBeansPath,
  ]);
  const rsbuild = await createRsbuild({
    cwd: projectRoot,
    callerName: "reforce-cli",
    config: {
      mode: "development",
      logLevel: "error",
      source: {
        decorators: { version: "2022-03" },
        entry: { main: "reforce:dev-entry" },
        tsconfigPath: options.project.tsconfigPath,
      },
      output: {
        target: "node",
        module: true,
        autoExternal: false,
        distPath: { root: devOutputRoot, js: "", jsAsync: "chunks" },
        filename: { js: "[name].mjs" },
        filenameHash: false,
        sourceMap: true,
        legalComments: "none",
        cleanDistPath: false,
        minify: false,
      },
      performance: { printFileSize: false },
      splitChunks: false,
      tools: {
        rspack(config) {
          config.optimization ??= {};
          config.optimization.emitOnErrors = false;
          config.output ??= {};
          config.output.chunkFormat = "module";
          config.output.chunkLoading = "import";
          config.output.publicPath = "./";
          config.output.hotUpdateChunkFilename = hotUpdateChunkFilename;
          config.output.hotUpdateMainFilename = hotUpdateManifestFilename;
          config.plugins.push(
            gatePlugin,
            new rspack.experiments.VirtualModulesPlugin({
              [virtualEntryPath]: renderDevelopmentEntry(),
            }),
            new rspack.NormalModuleReplacementPlugin(/^reforce:dev-entry$/u, virtualEntryPath),
            new rspack.NormalModuleReplacementPlugin(/^reforce:dev-runtime$/u, devRuntimePath),
            new rspack.NormalModuleReplacementPlugin(
              /^reforce:application-bootstrap$/u,
              generatedBootstrapPath,
            ),
            new rspack.HotModuleReplacementPlugin(),
          );
          const onInvalidated = options.onInvalidated;
          if (onInvalidated) {
            config.plugins.push({
              apply(compiler: Rspack.Compiler) {
                compiler.hooks.invalid.tap("ReforceInvalidationObserver", (path) =>
                  onInvalidated(path),
                );
              },
            });
          }
          // starter 包根的 reforce.js 是唯一以 realpath 形态进模块图的包根运行时模块（#180）：
          // symlink workspace 包经 resolve 后它不含 node_modules / dist 段，逃过具名目录忽略。
          // 它是约定的常量 no-op handle（`export default Object.freeze({})`），按名忽略即可；
          // 不用 resolve.symlinks:false 压制——那会破坏 Windows junction 链上的依赖解析。
          config.watchOptions = {
            ...config.watchOptions,
            aggregateTimeout: 200,
            ignored: [
              ...unwatchedDirectoryNames.flatMap((name) => [`**/${name}`, `**/${name}/**`]),
              "**/reforce.js",
            ],
          };
        },
      },
    },
  });

  rsbuild.onAfterBuild(async ({ stats }) => {
    // 诊断只有 gate 的 failure 分支拿得到；其余失败都是「编译没走到产出这一步」，统一按空诊断上报。
    const reportError = (error: unknown) =>
      options.onCompilation({ status: "failure", diagnostics: [], error });
    const gateResult = gatePlugin.current;
    if (!gateResult) {
      await reportError(new Error("Development compiler gate result is unavailable."));
      return;
    }
    if (gateResult.status === "failure") {
      await options.onCompilation({
        status: "failure",
        diagnostics: gateResult.diagnostics,
      });
      return;
    }
    if (gateResult.status === "error") {
      await reportError(gateResult.error);
      return;
    }
    if (!stats) {
      await reportError(new Error("Development build did not return compilation statistics."));
      return;
    }
    const buildError = statsError(stats);
    if (buildError) {
      await reportError(buildError);
      return;
    }
    let buildId: string;
    try {
      buildId = createDevBuildId(statsHash(stats));
    } catch (error) {
      // 缺 hash 是「构建没走到产出」的一种，和上面几条一样按失败上报；让它从 onAfterBuild 逃出去只会
      // 变成一条无人处理的 rejection，dev 会话既不上报也不退出（Issue #111）。
      await reportError(error);
      return;
    }
    const assets = await collectAssets(devOutputRoot);
    await options.onCompilation({
      status: "success",
      buildId,
      validateAssets: async () => {
        if (!assets.some((asset) => asset.path === "main.mjs" && asset.role === "entry")) {
          throw new Error("Development output does not contain main.mjs.");
        }
        if (!assets.some((asset) => asset.role === "chunk")) {
          throw new Error("Development output does not contain the bootstrap chunk.");
        }
      },
    });
  });

  let watch: Awaited<ReturnType<typeof rsbuild.build>> | undefined;
  let devWatch: DevWatchBuild | undefined;
  try {
    watch = await rsbuild.build({ watch: true });
    devWatch = createDevWatchBuild(watch, gatePlugin.compiler);
    await waitForRspackWatcher(gatePlugin, projectRoot);
  } catch (error) {
    try {
      await devWatch?.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Development watcher startup failed.", {
        cause: error,
      });
    }
    throw error;
  }
  return devWatch;
}
