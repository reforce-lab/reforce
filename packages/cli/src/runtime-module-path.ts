import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
