import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { compareUtf16CodeUnits, toPortablePath } from "@reforce/primitives";
import { createRsbuild, type Rspack, rspack } from "@rsbuild/core";
import { createDevBuildId, type DevBuildAsset } from "@/bundling/build-id";
import type { ResolvedProject } from "@/compiler-types";
import type { DevCompilerGate, DevCompilerGateResult } from "@/dev/compiler-gate";
import type { DevCompilation } from "@/dev/watch-coordinator";
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
function isProjectWatchFile(projectRoot: string, path: string): boolean {
  const pathFromRoot = relative(projectRoot, path);
  if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    return false;
  }
  const firstSegment = pathFromRoot.split(sep)[0];
  return (
    firstSegment !== ".reforce" &&
    firstSegment !== ".git" &&
    firstSegment !== "dist" &&
    firstSegment !== "node_modules"
  );
}

// startDevWatchBuild must not resolve until the rspack watcher has registered every gate watch
// input in fileTimeInfoEntries; that invariant guarantees a file modification made immediately
// after startup triggers a rebuild instead of being silently missed. The watcher reports its
// inputs asynchronously, so poll with setImmediate. Missing files never appear in the watcher,
// so after 5s this fails hard rather than degrading into a watch session that loses changes.
async function waitForRspackWatcher(
  plugin: ReforceCompilerGatePlugin,
  projectRoot: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const watcher = plugin.compiler?.watching?.watcher;
    const projectFiles = plugin.current?.watchInputs.fileDependencies.filter((path) =>
      isProjectWatchFile(projectRoot, path),
    );
    if (
      watcher !== undefined &&
      projectFiles !== undefined &&
      projectFiles.length > 0 &&
      projectFiles.every((path) => watcher.getInfo().fileTimeInfoEntries.has(path))
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Development filesystem watcher did not become ready.");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function renderDevelopmentEntry(): string {
  return `import { createRspackHmrRuntime, runDevelopmentApplication } from "reforce:dev-runtime";

const hot = import.meta.webpackHot;
if (!hot) {
  throw new Error("Reforce development entry requires the Rspack HMR runtime.");
}

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
  if (path.includes("hot-update") || path.startsWith("updates/")) {
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
          config.output.hotUpdateChunkFilename = "updates/[id].[fullhash].hot-update.mjs";
          config.output.hotUpdateMainFilename = "updates/[runtime].[fullhash].hot-update.json";
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
    const gateResult = gatePlugin.current;
    if (!gateResult) {
      await options.onCompilation({
        status: "failure",
        diagnostics: [],
        error: new Error("Development compiler gate result is unavailable."),
      });
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
      await options.onCompilation({ status: "failure", diagnostics: [], error: gateResult.error });
      return;
    }
    if (!stats) {
      await options.onCompilation({
        status: "failure",
        diagnostics: [],
        error: new Error("Development build did not return compilation statistics."),
      });
      return;
    }
    const buildError = statsError(stats);
    if (buildError) {
      await options.onCompilation({ status: "failure", diagnostics: [], error: buildError });
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
