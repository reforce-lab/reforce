import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";

export interface EnvironmentSnapshot {
  /** 四个提供方层合并后的值（schema 默认值是第五层，活在用户 schema 内部）。 */
  readonly values: ReadonlyMap<string, string>;
  /** key → 胜出层标签（".env" / ".env.local" / ".env.<profile>" / "process-env"）。 */
  readonly provenance: ReadonlyMap<string, string>;
  readonly warnings: readonly string[];
}

export interface LoadEnvironmentSnapshotInput {
  readonly root: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

// 方言唯一真相是 dotenv 的 parse()：不做 ${} 展开，也不走会写 process.env 的 config()
// （ADR 0005 决策 4.2）
function readEnvFile(root: string, name: string): Record<string, string> | undefined {
  let content: string;
  try {
    content = readFileSync(join(root, name), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return parse(content);
}

interface LayerMerge {
  readonly values: Map<string, string>;
  readonly provenance: Map<string, string>;
}

function mergeFileLayers(root: string, names: readonly string[]): LayerMerge {
  const values = new Map<string, string>();
  const provenance = new Map<string, string>();
  for (const name of names) {
    const parsed = readEnvFile(root, name);
    if (parsed === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(parsed)) {
      values.set(key, value);
      provenance.set(key, name);
    }
  }
  return { values, provenance };
}

export function loadEnvironmentSnapshot(input: LoadEnvironmentSnapshotInput): EnvironmentSnapshot {
  const profile = input.env.REFORCE_PROFILE?.trim();
  const profileFile = profile !== undefined && profile.length > 0 ? `.env.${profile}` : undefined;

  const fileNames = profileFile === undefined ? [] : [profileFile];
  const merged = mergeFileLayers(input.root, [".env", ".env.local", ...fileNames]);

  const values = merged.values;
  const provenance = merged.provenance;
  // process-env 恒为最高层：Node 不会把 .env 自动拷进 process.env（Node 26.4 实测），
  // Bun 时代的镜像降级逻辑（ADR 0005 决策 4.3）随之移除。
  for (const [key, value] of Object.entries(input.env)) {
    if (value === undefined) {
      continue;
    }
    values.set(key, value);
    provenance.set(key, "process-env");
  }

  const warnings: string[] = [];
  const nodeEnv = input.env.NODE_ENV;
  if (
    nodeEnv !== undefined &&
    nodeEnv.length > 0 &&
    profileFile !== undefined &&
    `.env.${nodeEnv}` !== profileFile &&
    existsSync(join(input.root, `.env.${nodeEnv}`))
  ) {
    warnings.push(
      `.env.${nodeEnv} exists but is not part of Reforce config layering; ` +
        `Reforce loads .env, .env.local and .env.<REFORCE_PROFILE> (REFORCE_PROFILE=${profile}).`,
    );
  }

  return { values, provenance, warnings };
}
