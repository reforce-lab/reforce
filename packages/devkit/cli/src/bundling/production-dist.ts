import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { compareUtf16CodeUnits, isRelativePosixPath, toPortablePath } from "@reforce/primitives";
import { type BuildResult, createRsbuild, rspack } from "@rsbuild/core";
import { isObject } from "radashi";
import { renderProductionEntry } from "@/bundling/production-entry";
import { resolveRuntimeEntryPath } from "@/bundling/runtime-locator";
import type { ResolvedProject } from "@/compiler-types";

function assertAssetPath(path: string): void {
  if (!isRelativePosixPath(path)) {
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

// source map 落在 asset.info.related.sourceMap，不是顶层的 related 数组——后者在这套 stats
// preset 下恒为空（filteredRelated 计数说明它被过滤掉了）。这里读的是构建自己声明的伴生
// 产物名，不是按 `${name}.map` 猜出来的（RFC 0011 D6，#242）。
function collectDeclaredRelatedAssets(asset: object, files: Set<string>): void {
  const info = Reflect.get(asset, "info");
  if (!isObject(info)) {
    return;
  }
  const related = Reflect.get(info, "related");
  if (!isObject(related)) {
    return;
  }
  for (const key of Reflect.ownKeys(related)) {
    const value = Reflect.get(related, key);
    for (const name of Array.isArray(value) ? value : [value]) {
      if (typeof name !== "string") {
        throw new Error("Production build returned an invalid related asset name.");
      }
      assertAssetPath(name);
      files.add(name);
    }
  }
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
  collectDeclaredRelatedAssets(asset, files);
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
  // relatedAssets 必须显式开：source map 是主产物的 related asset，不开时 stats 里根本没有
  // 这一层，落盘校验会把磁盘上真实存在的 .map 判成「多出来的文件」（RFC 0011 D6，#242）。
  collectStatsAssets(
    stats.toJson({ all: false, assets: true, children: true, relatedAssets: true }),
    files,
  );
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

async function collectOutputFiles(root: string): Promise<readonly string[]> {
  // Only the top-level result needs sorting: inner levels are spread into the parent list, so
  // their order is discarded anyway. The per-directory `entries.sort` below is kept because it
  // fixes traversal order, which decides which error is thrown first when several entries are bad.
  return (await collectOutputFilesInto(root, root)).sort(compareUtf16CodeUnits);
}

async function collectOutputFilesInto(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Production output cannot contain a symbolic link: ${absolutePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectOutputFilesInto(root, absolutePath)));
      continue;
    }
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile()) {
      throw new Error(`Production output must contain ordinary files: ${absolutePath}`);
    }
    files.push(toPortablePath(relative(root, absolutePath)));
  }
  return files;
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
  const productionRuntimePath = resolveRuntimeEntryPath("production-runtime");
  const devErrorPageStubPath = join(
    input.project.projectRoot,
    ".reforce",
    "virtual",
    "dev-error-page-stub.mjs",
  );
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
        // nosources 而不是完整 source-map（RFC 0011 D6，#242）：栈帧要重定位回用户源文件，
        // 但产物里不能出现源码正文——it/integration/production-build.spec.ts 会读遍全部产物
        // 断言不含构建期依赖的名字，`sourcesContent` 会把它们整片带进来。代价写进文档：生产
        // 的失败输出只有「文件:行」，没有源码框。
        sourceMap: { js: "nosources-source-map" },
        legalComments: "none",
        cleanDistPath: false,
        minify: false,
      },
      performance: { printFileSize: false },
      splitChunks: false,
      tools: {
        rspack(config) {
          config.output ??= {};
          config.output.chunkFormat = "module";
          config.output.chunkLoading = "import";
          // sources[] 的基准（D6 C4）：target "node" 下 rsbuild 固定用 [relative-resource-path]，
          // 而 Node 的 --enable-source-maps 按「生成文件所在目录」解析相对 source，于是每条
          // 帧都指向 dist/src/… 这种不存在的路径。写成绝对路径后重定位才落到真实源文件。
          config.output.devtoolModuleFilenameTemplate = "[absolute-resource-path]";
          config.optimization ??= {};
          // dev 错误页「生产不含」的第一道闸（#279）：web 里通往 dev-error-page 的动态 import
          // 藏在 `process.env.NODE_ENV !== "production"` 后面，靠 DefinePlugin 折叠成死代码
          // 整块消失。今天 mode: "production" 隐式给出同一值，显式钉死是防 mode 与 nodeEnv
          // 的绑定关系在 rsbuild/rspack 升级中悄悄漂移。
          config.optimization.nodeEnv = "production";
          config.plugins.push(
            new rspack.experiments.VirtualModulesPlugin({
              [virtualEntryPath]: renderProductionEntry(),
              [devErrorPageStubPath]: "export {};\n",
            }),
            // 第二道闸（#279）：即使第一道的折叠失效，生产产物里的 dev-error-page 也被替换成
            // 上面的空 stub——「生产不含渲染器」从 DCE 承诺升级为构建配置承诺。上下文限定
            // @reforce/web-core 的 dist/execution（workspace 与发布布局的公共尾段），不误伤用户
            // 自己的同名文件。stub 导出为空：万一真被引用，解构得 undefined、调用即抛，落进
            // error-dispatch 的降级 catch，仍守住 problem+json。
            new rspack.NormalModuleReplacementPlugin(/(?:^|[\\/])dev-error-page\.js$/u, (data) => {
              if (toPortablePath(data.context).endsWith("web/dist/execution")) {
                data.request = devErrorPageStubPath;
              }
            }),
            new rspack.NormalModuleReplacementPlugin(
              /^reforce:production-entry$/u,
              virtualEntryPath,
            ),
            new rspack.NormalModuleReplacementPlugin(
              /^reforce:production-runtime$/u,
              productionRuntimePath,
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
  let buildResult: BuildResult | undefined;
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
  // Unreachable at runtime: closeProductionBuild always throws when the try block above failed
  // before assigning expectedFiles. The check only narrows the `let` for TypeScript, which cannot
  // see that guarantee across the call.
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
