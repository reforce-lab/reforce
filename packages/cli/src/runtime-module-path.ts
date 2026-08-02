import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export function resolveCliSupportModule(options: {
  readonly supportModuleName: string;
  readonly invokedEntryPath?: string;
}): string {
  if (options.invokedEntryPath !== undefined) {
    try {
      const entryPath = realpathSync(options.invokedEntryPath);
      for (const extension of [".js", ".ts"] as const) {
        const candidate = join(dirname(entryPath), `${options.supportModuleName}${extension}`);
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      }
    } catch {}
  }

  const sourceCandidate = join(process.cwd(), "src", `${options.supportModuleName}.ts`);
  if (existsSync(sourceCandidate) && statSync(sourceCandidate).isFile()) {
    return sourceCandidate;
  }
  throw new Error(`Unable to resolve CLI support module ${options.supportModuleName}.`);
}
