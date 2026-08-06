import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";

// 编译期的 .env 通道（RFC 0011 L5，#242）。
//
// 编译器此前对配置的感知止步于「配置类 + prefix 字面量」，`.env` 的键一个也读不到。要在编译期
// 校验 `LOGGING_LEVEL_<NAME>` 指向的 logger 名存不存在，就必须能看见键名。
//
// **只读键名，值一律不读进任何产物**：ADR 0005 决策 6.2 的「诊断数据永不携带配置值」在这里
// 同样成立——本模块拿到 parse() 的结果后立刻丢掉 value，只留 key。
//
// 与 @reforce/config 的 binding/env-layers.ts 是两条独立通道，共享的只有 dotenv 版本与层顺序：
// 那边要做的是绑定（盲展开 key path、大小写归一），这边只需要精确查表。共用代码会把
// buildBindingInput 的 toLowerCase 带进来，而那一步会让 `payments.Gateway` 与
// `payments.gateway` 变成同一个键，反解不回原名。

// 与 @reforce/logging 的 environmentKeyForLogger、analysis/logger-levels.ts 的同名常量必须
// 逐字一致：三处算出不同的前缀，编译期读到的键与运行期查的键就对不上。
const loggingLevelPrefix = "LOGGING_LEVEL_";

export interface EnvironmentKeyLayers {
  /** 编译期见到的全部键名，按层合并后去重。 */
  readonly keys: ReadonlySet<string>;
  /**
   * `LOGGING_LEVEL_*` 的原始值，后一层压过前一层。
   *
   * 这是本模块「只读键名」的唯一例外，范围窄到只有这一个前缀：级别快照要能内联进生成物，
   * 而级别的**值**正是那个快照的内容（RFC 0011 L5）。它不是配置值意义上的秘密——取值域是
   * 六个级别名的封闭集合，反解不出任何应用数据。其余键的值照旧在 parse() 之后立刻丢掉，
   * ADR 0005 决策 6.2 因此不破。
   */
  readonly loggingLevelValues: ReadonlyMap<string, string>;
  /** 实际读到的层，按读取顺序；写进 LoggerLevels 快照供启动期比对。 */
  readonly layers: readonly string[];
  /** 存在的层文件绝对路径，进 fileDependencies。 */
  readonly presentFiles: readonly string[];
  /** 缺席的层文件绝对路径，进 missingDependencies——dev 下新建 .env 才能触发重编译。 */
  readonly missingFiles: readonly string[];
}

// 层顺序必须与 @reforce/config 的 loadEnvironmentSnapshot 一致，否则编译期看见的键集与运行期
// 的不是同一套。profile 层只在编译期设了 REFORCE_PROFILE 时可见——它是运行期进程变量，
// `reforce build` 与 `reforce start` 的取值可能不同，这一点由 LoggerLevels 的 layers 快照
// 在启动时如实比对。
export function environmentLayerNames(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const profile = env.REFORCE_PROFILE?.trim();
  const profileFile = profile !== undefined && profile.length > 0 ? `.env.${profile}` : undefined;
  return profileFile === undefined ? [".env", ".env.local"] : [".env", ".env.local", profileFile];
}

export function readEnvironmentKeyLayers(input: {
  readonly projectRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): EnvironmentKeyLayers {
  const keys = new Set<string>();
  const loggingLevelValues = new Map<string, string>();
  const layers: string[] = [];
  const presentFiles: string[] = [];
  const missingFiles: string[] = [];
  for (const name of environmentLayerNames(input.env)) {
    const path = join(input.projectRoot, name);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      // 读不到一律当缺席：编译期校验是尽力而为的辅助，一个权限问题不该让整个编译失败。
      missingFiles.push(path);
      continue;
    }
    presentFiles.push(path);
    layers.push(name);
    for (const [key, value] of Object.entries(parse(content))) {
      keys.add(key);
      if (key.startsWith(loggingLevelPrefix)) {
        loggingLevelValues.set(key, value);
      }
    }
  }
  return { keys, loggingLevelValues, layers, presentFiles, missingFiles };
}
