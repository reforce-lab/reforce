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
  readonly bunAutoLoaded: boolean;
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

// Bun 自动加载的文件清单跟 NODE_ENV 走（Bun 1.3.14 实测，2026-08-04）：NODE_ENV 缺省视为
// development；只有 development/production/test 三值触发 .env.{NODE_ENV}；test 下额外跳过
// .env.local（CRA/Vite 同一惯例）。优先级 .env < .env.{NODE_ENV} < .env.local。
function bunAutoLoadedFiles(nodeEnv: string | undefined): readonly string[] {
  const effective = nodeEnv === undefined || nodeEnv.length === 0 ? "development" : nodeEnv;
  return [
    ".env",
    ...(effective === "development" || effective === "production" || effective === "test"
      ? [`.env.${effective}`]
      : []),
    ...(effective === "test" ? [] : [".env.local"]),
  ];
}

export function loadEnvironmentSnapshot(input: LoadEnvironmentSnapshotInput): EnvironmentSnapshot {
  const profile = input.env.REFORCE_PROFILE?.trim();
  const profileFile = profile !== undefined && profile.length > 0 ? `.env.${profile}` : undefined;

  // Bun 启动时把自动加载文件族拷进 process.env；降级判断要对着这份"Bun 镜像"（按 Bun 的
  // 真实清单合成，而不是框架自己的分层）——否则 .env.<profile> 对被拷贝键的覆盖永远不成立，
  // bun test（NODE_ENV=test 跳过 .env.local）下还会把 .env 的拷贝误判成外部注入。
  // 镜像命中但键不在框架分层内（如 .env.test 独有键）就整个丢弃：Node/Deno 下它本不存在，
  // 保留会破坏多运行时一致性（ADR 0005 决策 4.1/3.3，.env.{NODE_ENV} 不进框架分层）。
  const bunMirror = mergeFileLayers(input.root, bunAutoLoadedFiles(input.env.NODE_ENV));
  const fileNames = profileFile === undefined ? [] : [profileFile];
  const merged = mergeFileLayers(input.root, [".env", ".env.local", ...fileNames]);

  const values = merged.values;
  const provenance = merged.provenance;
  for (const [key, value] of Object.entries(input.env)) {
    if (value === undefined) {
      continue;
    }
    // Bun 降级（ADR 0005 决策 4.3）：process.env 值与文件层逐字符相等 ⇒ 视为 Bun 自动
    // 拷贝，归属还给文件层，让 .env.<profile> 得以覆盖；不相等则 process-env 仍是最高层。
    // 非 Bun 运行时由调用方传 bunAutoLoaded=false，天然不降级
    if (input.bunAutoLoaded && bunMirror.values.get(key) === value) {
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
