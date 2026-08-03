import { lstat, readdir, readFile } from "node:fs/promises";
import nodePath, { join, relative } from "node:path";
import {
  compareUtf16CodeUnits,
  isPathStrictlyContained,
  type PathSemantics,
  toPortablePath,
} from "@reforce/primitives";
import { createRsbuild, type Rspack, rspack } from "@rsbuild/core";
import { createDevBuildId, type DevBuildAsset } from "@/bundling/build-id";
import type { ResolvedProject } from "@/compiler-types";
import type { DevCompilerGate, DevCompilerGateResult } from "@/dev/compiler-gate";
import type { DevCompilation } from "@/dev/watch-coordinator";
import {
  hotUpdateChunkFilename,
  hotUpdateDirectory,
  hotUpdateManifestFilename,
} from "@/dev-hot-update";
import { resolveCliSupportModule } from "@/runtime-module-path";

export interface DevWatchBuild {
  close(): Promise<void>;
}

export interface StartDevWatchBuildOptions {
  readonly project: ResolvedProject;
  readonly gate: DevCompilerGate;
  readonly onCompilation: (compilation: DevCompilation) => Promise<void>;
  readonly onInvalidated?: (path: string | null) => void;
}

// This filter and the watchOptions.ignored glob list below cover the same directory names on
// purpose, but with different semantics: here only the top-level segment counts because gate
// watch inputs are project-rooted, while ignored matches those names at any depth. The two
// lists must stay coupled so that every gate watch input passing this filter is never matched
// by ignored — otherwise the watcher would never report it and waitForRspackWatcher times out.
//
// Exported only so the containment rule can be unit tested: reaching it through
// startDevWatchBuild needs a live rspack watcher, and the Windows cross-drive case cannot be
// produced on the runner at all. semantics is injectable for the same reason — a non-Windows
// runner has to be able to exercise win32 path rules; the default keeps callers unaware.
export function isProjectWatchFile(
  projectRoot: string,
  path: string,
  semantics: PathSemantics = nodePath,
): boolean {
  // Strict containment: projectRoot itself is a directory, never a watched file.
  if (!isPathStrictlyContained(projectRoot, path, semantics)) {
    return false;
  }
  const firstSegment = semantics.relative(projectRoot, path).split(semantics.sep)[0];
  return (
    firstSegment !== ".reforce" &&
    firstSegment !== ".git" &&
    firstSegment !== "dist" &&
    firstSegment !== "node_modules"
  );
}

// 每轮之间让出的时间。原实现用 setImmediate，那不是「等待」而是热自旋：它以 event loop 的循环
// 速度反复检查，实测本机空载 45ms 就绪要转 1000–5000 圈、满载 200ms 就绪要转 5000–21000 圈，
// 开销随等待时长线性膨胀，而烧掉的正是 watcher 自己的文件系统回调所需要的 CPU。定时轮询把它
// 降到个位数次，代价是就绪检测最多晚一个间隔（Issue #83）。
const watcherPollIntervalMilliseconds = 10;

// 判死的依据是「不再有进展」，不是「花了多久」。原实现用固定 5 秒总预算，那个数按开发机速度
// 标定：项目更大、机器更慢、或同时跑多个 dev 时，watcher 只是还没登记完就被判成永远不会就绪，
// 用户会拿到一个假的失败（Issue #83）。已登记数还在增长就说明它在干活，继续等；只有停滞超过
// 下面这个窗口才说明真的卡住了。等待上限因此自动随项目规模伸缩，与平台速度无关。
const watcherProgressStallBudgetMilliseconds = 10_000;

// startDevWatchBuild must not resolve until the rspack watcher has registered every gate watch
// input in fileTimeInfoEntries; that invariant guarantees a file modification made immediately
// after startup triggers a rebuild instead of being silently missed.
async function waitForRspackWatcher(
  plugin: ReforceCompilerGatePlugin,
  projectRoot: string,
): Promise<void> {
  let lastProgress = "";
  let lastProgressAt = Date.now();
  while (true) {
    const projectFiles =
      plugin.current?.watchInputs.fileDependencies.filter((path) =>
        isProjectWatchFile(projectRoot, path),
      ) ?? [];
    // getInfo() 每次都会重建整张表，一轮只取一次。
    const registeredFiles = plugin.compiler?.watching?.watcher?.getInfo().fileTimeInfoEntries;
    const registered =
      registeredFiles === undefined
        ? 0
        : projectFiles.filter((path) => registeredFiles.has(path)).length;
    if (projectFiles.length > 0 && registered === projectFiles.length) {
      return;
    }
    // watchInputs 自己也可能还在增长，所以「有进展」要同时看已登记数和待登记总数。
    const progress = `${registered}/${projectFiles.length}`;
    if (progress !== lastProgress) {
      lastProgress = progress;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt >= watcherProgressStallBudgetMilliseconds) {
      throw new Error("Development filesystem watcher stopped making progress.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, watcherPollIntervalMilliseconds));
  }
}

function renderDevelopmentEntry(): string {
  return `import { createRspackHmrRuntime, runDevelopmentApplication } from "reforce:dev-runtime";

const hot = import.meta.webpackHot;
if (!hot) {
  throw new Error("Reforce development entry requires the Rspack HMR runtime.");
}

// Must stay written exactly like this — on the full \`import.meta.webpackHot\` member expression,
// with a literal specifier, in the module that owns this hot object. rspack rewrites the accepted
// request into a module id at build time by matching that expression shape; going through the
// \`hot\` alias above, or passing a variable from runtime/hmr-manager.ts, leaves the raw string in
// the output and \`_acceptedDependencies\` is then keyed by something no dependency ever matches.
// That is why every update used to propagate past this entry and abort as "not accepted"
// (Issue #46).
import.meta.webpackHot.accept("reforce:application-bootstrap");

process.exitCode = await runDevelopmentApplication({
  hot: createRspackHmrRuntime(hot),
  loadBootstrap: () => import("reforce:application-bootstrap"),
});
`;
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
    assets.push({ path, bytes: await readFile(absolutePath), role: assetRole(path) });
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

function addWatchInputs(compilation: Rspack.Compilation, result: DevCompilerGateResult): void {
  compilation.fileDependencies.addAll(result.watchInputs.fileDependencies);
  compilation.contextDependencies.addAll(result.watchInputs.contextDependencies);
  compilation.missingDependencies.addAll(result.watchInputs.missingDependencies);
}

function addGateErrors(compilation: Rspack.Compilation, result: DevCompilerGateResult): void {
  if (result.status === "success") {
    return;
  }
  if (result.status === "error") {
    compilation.errors.push(
      new rspack.WebpackError("Reforce compiler gate failed", { cause: result.error }),
    );
    return;
  }
  for (const diagnostic of result.diagnostics) {
    compilation.errors.push(new rspack.WebpackError(`[${diagnostic.code}] ${diagnostic.message}`));
  }
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

class ReforceCompilerGatePlugin {
  private readonly gate: DevCompilerGate;
  private readonly generatedModules: readonly string[];
  private currentValue: DevCompilerGateResult | undefined;
  private compilerValue: Rspack.Compiler | undefined;
  private knownWatchFiles = new Set<string>();

  constructor(gate: DevCompilerGate, generatedModules: readonly string[]) {
    this.gate = gate;
    this.generatedModules = generatedModules;
  }

  get current(): DevCompilerGateResult | undefined {
    return this.currentValue;
  }

  get compiler(): Rspack.Compiler | undefined {
    return this.compilerValue;
  }

  apply(compiler: Rspack.Compiler): void {
    this.compilerValue = compiler;
    compiler.hooks.beforeCompile.tapPromise("ReforceCompilerGate", () =>
      this.prepareCompilation(compiler),
    );
    compiler.hooks.thisCompilation.tap("ReforceCompilerGate", (compilation) => {
      const current = this.currentValue;
      if (!current) {
        compilation.errors.push(new rspack.WebpackError("Reforce compiler gate did not run."));
        return;
      }
      addWatchInputs(compilation, current);
      addGateErrors(compilation, current);
    });
  }

  private async prepareCompilation(compiler: Rspack.Compiler): Promise<void> {
    const initial = this.gate.takeInitialResult();
    this.currentValue = initial ?? (await this.gate.compileNext());
    if (initial === undefined) {
      this.markModifiedFiles(compiler, this.currentValue);
    }
    this.knownWatchFiles = new Set(this.currentValue.watchInputs.fileDependencies);
  }

  private markModifiedFiles(compiler: Rspack.Compiler, current: DevCompilerGateResult): void {
    const modifiedFiles = new Set(compiler.modifiedFiles);
    if (current.status === "success") {
      for (const generatedModule of this.generatedModules) {
        modifiedFiles.add(generatedModule);
      }
    }
    for (const watchFile of current.watchInputs.fileDependencies) {
      if (!this.knownWatchFiles.has(watchFile)) {
        modifiedFiles.add(watchFile);
      }
    }
    compiler.modifiedFiles = modifiedFiles;
  }
}

export async function startDevWatchBuild(
  options: StartDevWatchBuildOptions,
): Promise<DevWatchBuild> {
  const { projectRoot } = options.project;
  const virtualEntryPath = join(projectRoot, ".reforce", "virtual", "dev-entry.mjs");
  const devOutputRoot = join(projectRoot, ".reforce", "dev");
  const generatedBootstrapPath = join(projectRoot, ".reforce", "generated", "bootstrap.ts");
  const generatedBeansPath = join(projectRoot, ".reforce", "generated", "beans.ts");
  const devRuntimePath = resolveCliSupportModule({
    supportModuleName: "dev-runtime",
    invokedEntryPath: process.argv[1],
  });
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
          config.watchOptions = {
            ...config.watchOptions,
            aggregateTimeout: 200,
            ignored: [
              "**/.reforce",
              "**/.reforce/**",
              "**/.git",
              "**/.git/**",
              "**/dist",
              "**/dist/**",
              "**/node_modules",
              "**/node_modules/**",
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
    const assets = await collectAssets(devOutputRoot);
    await options.onCompilation({
      status: "success",
      buildId: createDevBuildId({ statsHash: statsHash(stats), assets }),
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
