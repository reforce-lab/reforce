import path from "node:path";
import { toPortablePath } from "@reforce/primitives";
import type { TsConfigJsonResolved } from "get-tsconfig";
import { glob } from "tinyglobby";
import { sortNativePaths } from "@/determinism";

export const sourceSuffixPattern = /\.(?:ts|tsx|mts|cts)$/u;
export const declarationSuffixPattern = /\.d\.(?:ts|mts|cts)$/u;

// win32 上的绝对 pattern 会带一截合成的 `./`：get-tsconfig 的 normalizeRelativePath 对
// path.relative relativize 不掉的路径（跨盘符、跨 share）无条件加 `./` 前缀，于是盘符形态浮上来是
// `./C:/…`、UNC 形态是 `.///…`。两种剥的是同一截前缀，所以只能有一份实现：此前拆成两条分支各写一次
// slice，UNC 那条少剥了一位，留下的 `///server/share` 在 path.win32.resolve 里不再是 UNC 根，
// 被重解释成项目所在盘上的路径（Issue #390）。
const syntheticWin32Prefix = /^\.\/(?=[A-Za-z]:\/|\/\/)/u;

// win32 形态可注入而不是直接读 process.platform：这条改写在 POSIX 上不能无条件执行，`.///foo`
// 剥掉前缀后是 `/foo`，语义就变了。注入之后 Linux 上也能对 win32 那半下断言（Issue #381）。
export function normalizePattern(
  pattern: string,
  { windows = process.platform === "win32" } = {},
): string {
  const portable = pattern.replaceAll("\\", "/");
  return windows ? portable.replace(syntheticWin32Prefix, "") : portable;
}

function normalizePatterns(patterns: readonly string[] | undefined): readonly string[] {
  return patterns?.map((pattern) => normalizePattern(pattern)) ?? [];
}

// Deliberately broader than tsc: `dot: true` makes `**/*` reach `.reforce/generated`, which tsc's
// wildcard segments never do. The two answers only differ on dot directories, and the difference
// is confined to watchInputs.fileDependencies — `isApplicationSource` drops generated files from
// the compilation input, and `generatedOutputIsIncluded` answers the "will the user's tsc
// see the qualifiers" question on its own with true tsc semantics (Issue #60). Watching a
// generated file we also list under missingDependencies is harmless; missing it would not be.
export async function discoverConfiguredFiles(
  config: TsConfigJsonResolved,
  projectRoot: string,
): Promise<readonly string[]> {
  const explicitFiles = normalizePatterns(config.files);
  const includePatterns = normalizePatterns(config.include);
  const excludePatterns = normalizePatterns(config.exclude);
  const fromFiles = explicitFiles.map((file) => path.resolve(projectRoot, file));
  const patterns =
    config.include === undefined && config.files === undefined ? ["**/*"] : includePatterns;
  const fromIncludes =
    patterns.length === 0
      ? []
      : await glob(patterns, {
          cwd: projectRoot,
          absolute: true,
          dot: true,
          onlyFiles: true,
          followSymbolicLinks: true,
          ignore: [
            "**/node_modules/**",
            "**/bower_components/**",
            "**/jspm_packages/**",
            ...excludePatterns,
          ],
        });
  return sortNativePaths([...fromFiles, ...fromIncludes]).filter((file) =>
    sourceSuffixPattern.test(toPortablePath(file)),
  );
}
