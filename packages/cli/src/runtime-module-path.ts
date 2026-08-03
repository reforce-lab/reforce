import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 必须留在 `src/` 根：下面把 dist 当作「自身目录的兄弟目录」解析，只有本模块位于包根下一层时才成立
// —— 源码执行时是 `src/`，构建产物里是 `dist/`，两边深度都为 1。挪进任何领域目录都会让源码执行解析到
// `src/<domain>/../dist`。见 #28。
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export function resolveCliSupportModule(options: {
  readonly supportModuleName: string;
  readonly invokedEntryPath?: string;
}): string {
  if (options.invokedEntryPath !== undefined) {
    try {
      const entryPath = realpathSync(options.invokedEntryPath);
      const candidate = join(dirname(entryPath), `${options.supportModuleName}.js`);
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }

  const distributionCandidate = join(
    moduleDirectory,
    "..",
    "dist",
    `${options.supportModuleName}.js`,
  );
  if (existsSync(distributionCandidate) && statSync(distributionCandidate).isFile()) {
    return distributionCandidate;
  }
  throw new Error(`Unable to resolve CLI support module ${options.supportModuleName}.`);
}
