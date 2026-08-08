import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { type RawConfig, readRawConfig } from "@/project/tsconfig-jsonc";

export interface ConfigGraphObservation {
  readonly configPaths: string[];
  readonly missingPaths: string[];
}

async function resolveExtendedConfig(
  value: string,
  containingDirectory: string,
): Promise<{ readonly path?: string; readonly missingPaths: readonly string[] }> {
  const relativeCandidate = path.resolve(containingDirectory, value);
  const candidates =
    value.startsWith(".") || path.isAbsolute(value)
      ? [
          relativeCandidate,
          `${relativeCandidate}.json`,
          path.join(relativeCandidate, "tsconfig.json"),
        ]
      : [];
  for (const candidate of candidates) {
    try {
      return { path: await realpath(candidate), missingPaths: [] };
    } catch {
      // 候选路径不存在或不可达就试下一个；全部落空时整组候选记入 missingPaths。
    }
  }
  try {
    const requireFromConfig = createRequire(path.join(containingDirectory, "package.json"));
    return { path: await realpath(requireFromConfig.resolve(value)), missingPaths: [] };
  } catch {
    return { missingPaths: candidates };
  }
}

export async function collectConfigGraph(
  configPath: string,
  visited: Set<string>,
  observation: ConfigGraphObservation,
): Promise<RawConfig> {
  const canonicalPath = await realpath(configPath);
  if (visited.has(canonicalPath)) {
    return { extendValues: [], files: undefined, references: undefined };
  }
  visited.add(canonicalPath);
  observation.configPaths.push(canonicalPath);
  const raw = await readRawConfig(canonicalPath);
  for (const extendValue of raw.extendValues) {
    const resolved = await resolveExtendedConfig(extendValue, path.dirname(canonicalPath));
    if (resolved.path === undefined) {
      observation.missingPaths.push(...resolved.missingPaths);
      throw new Error(`Cannot resolve extended tsconfig ${extendValue}`);
    }
    await collectConfigGraph(resolved.path, visited, observation);
  }
  return raw;
}
