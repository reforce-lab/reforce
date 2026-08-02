import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { type BuildResult, createRsbuild, rspack } from "@rsbuild/core";
import { isObject } from "radashi";
import type { ResolvedProject } from "./compiler-types";
import { compareUtf16CodeUnits } from "./determinism";
import { renderProductionEntry } from "./production-entry";
import { resolveCliSupportModule } from "./runtime-module-path";

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}

function assertAssetPath(path: string): void {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Production stats returned an invalid asset path: ${path}`);
  }
}

function optionalArray(value: unknown, message: string): readonly unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(message);
  }
  return value;
}

function collectStatsAsset(asset: unknown, files: Set<string>): void {
  if (!isObject(asset)) {
    throw new Error("Production build returned an invalid stats asset.");
  }
  const name = Reflect.get(asset, "name");
  if (typeof name !== "string") {
    throw new Error("Production build returned an invalid stats asset.");
  }
  assertAssetPath(name);
  files.add(name);
  for (const related of optionalArray(
    Reflect.get(asset, "related"),
    "Production build returned invalid related assets.",
  )) {
    collectStatsAsset(related, files);
  }
}

function collectStatsAssets(value: unknown, files: Set<string>): void {
  if (!isObject(value)) {
    throw new Error("Production build returned an invalid stats asset graph.");
  }
  for (const asset of optionalArray(
    Reflect.get(value, "assets"),
    "Production build returned an invalid stats asset list.",
  )) {
    collectStatsAsset(asset, files);
  }
  for (const child of optionalArray(
    Reflect.get(value, "children"),
    "Production build returned an invalid child stats graph.",
  )) {
    collectStatsAssets(child, files);
  }
}

function statsAssetFiles(stats: NonNullable<BuildResult["stats"]>): readonly string[] {
  const files = new Set<string>();
  collectStatsAssets(stats.toJson({ all: false, assets: true, children: true }), files);
  return [...files].sort(compareUtf16CodeUnits);
}

function sameFiles(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

export async function closeProductionBuild(
  buildResult: Pick<BuildResult, "close"> | undefined,
  priorFailures: readonly unknown[],
): Promise<void> {
  const failures = [...priorFailures];
  try {
    await buildResult?.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Production build and cleanup both failed.", {
      cause: failures[0],
    });
  }
}

async function collectOutputFiles(root: string, directory = root): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Production output cannot contain a symbolic link: ${absolutePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectOutputFiles(root, absolutePath)));
      continue;
    }
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile()) {
      throw new Error(`Production output must contain ordinary files: ${absolutePath}`);
    }
    files.push(toPortablePath(relative(root, absolutePath)));
  }
  return files.sort(compareUtf16CodeUnits);
}

export async function buildProductionDist(input: {
  readonly project: ResolvedProject;
  readonly stagingDirectory: string;
}): Promise<readonly string[]> {
  const virtualEntryPath = join(
    input.project.projectRoot,
    ".reforce",
    "virtual",
    "production-entry.mjs",
  );
  const generatedBootstrapPath = join(
    input.project.projectRoot,
    ".reforce",
    "generated",
    "bootstrap.ts",
  );
  const productionRuntimePath = resolveCliSupportModule({
    supportModuleName: "production-runtime",
    invokedEntryPath: process.argv[1],
  });
  const rsbuild = await createRsbuild({
    cwd: input.project.projectRoot,
    callerName: "reforce-cli",
    config: {
      mode: "production",
      logLevel: "error",
      source: {
        decorators: { version: "2022-03" },
        entry: { main: "reforce:production-entry" },
        tsconfigPath: input.project.tsconfigPath,
      },
      output: {
        target: "node",
        module: true,
        autoExternal: false,
        distPath: { root: input.stagingDirectory, js: "", jsAsync: "chunks" },
        filename: { js: "[name].mjs" },
        filenameHash: false,
        sourceMap: false,
        legalComments: "none",
        cleanDistPath: false,
        minify: false,
      },
      performance: { printFileSize: false },
      resolve: {
        alias: {
          "#reforce-production-runtime": productionRuntimePath,
        },
      },
      splitChunks: false,
      tools: {
        rspack(config) {
          config.output ??= {};
          config.output.chunkFormat = "module";
          config.output.chunkLoading = "import";
          config.resolve ??= {};
          config.resolve.conditionNames = ["development", "node", "import", "module", "default"];
          config.plugins.push(
            new rspack.experiments.VirtualModulesPlugin({
              [virtualEntryPath]: renderProductionEntry(),
            }),
            new rspack.NormalModuleReplacementPlugin(
              /^reforce:production-entry$/u,
              virtualEntryPath,
            ),
            new rspack.NormalModuleReplacementPlugin(
              /^reforce:application-bootstrap$/u,
              generatedBootstrapPath,
            ),
          );
        },
      },
    },
  });
  let buildResult: Awaited<ReturnType<typeof rsbuild.build>> | undefined;
  let expectedFiles: readonly string[] | undefined;
  const buildFailures: unknown[] = [];
  try {
    buildResult = await rsbuild.build();
    if (buildResult.stats?.hasErrors()) {
      throw new Error(buildResult.stats.toString({ all: false, errors: true }));
    }
    if (!buildResult.stats) {
      throw new Error("Production build did not return an asset graph.");
    }
    expectedFiles = statsAssetFiles(buildResult.stats);
  } catch (error) {
    buildFailures.push(error);
  }
  await closeProductionBuild(buildResult, buildFailures);
  if (!expectedFiles) {
    throw new Error("Production build asset validation did not complete.");
  }
  const files = await collectOutputFiles(input.stagingDirectory);
  if (!sameFiles(files, expectedFiles)) {
    throw new Error("Production staging files do not exactly match the stats asset graph.");
  }
  if (!files.includes("main.mjs") || !files.some((file) => file.startsWith("chunks/"))) {
    throw new Error("Production output must contain main.mjs and its dynamic bootstrap chunk.");
  }
  return files;
}
