import path from "node:path";
import { toPortablePath } from "@reforce/primitives";
import type { TsConfigJsonResolved } from "get-tsconfig";
import { glob } from "tinyglobby";
import { sortNativePaths } from "@/determinism";

export const sourceSuffixPattern = /\.(?:ts|tsx|mts|cts)$/u;
export const declarationSuffixPattern = /\.d\.(?:ts|mts|cts)$/u;

// win32 形态可注入而不是直接读 process.platform：这两条改写在 POSIX 上不能无条件执行，`.///foo`
// 切掉首字符会变成绝对路径 `//foo`，语义就变了。注入之后 Linux 上也能对 win32 那半下断言（Issue #381）。
export function normalizePattern(
  pattern: string,
  { windows = process.platform === "win32" } = {},
): string {
  const portable = pattern.replaceAll("\\", "/");
  if (!windows) {
    return portable;
  }
  // On win32 an absolute pattern surfaces as "./C:/..." (and ".///..." for UNC once separators are
  // normalized); drop the synthetic prefix so glob matching sees the real path.
  if (/^\.\/[A-Za-z]:\//u.test(portable)) {
    return portable.slice(2);
  }
  // 只切掉那个点，留下的三条斜杠是现状而非结论：这个分支在 Windows runner 上也没有证据，改它需要
  // 先拿到真实的 get-tsconfig UNC 输出（Issue #381）。
  if (portable.startsWith(".///")) {
    return portable.slice(1);
  }
  return portable;
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
