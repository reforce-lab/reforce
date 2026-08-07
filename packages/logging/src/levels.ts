import { type LogThreshold, logThresholdValues } from "@/contracts";

// 级别表（RFC 0011 L5，#242）。这个 bean 由编译器合成，构造实参是编译期算好的字面量——
// 它是「编译期看见了什么」的快照，不是运行期配置面。
//
// layers 记录编译期实际读了哪几层 .env：REFORCE_PROFILE 是运行期进程变量，`reforce build`
// 时的值可能与 `reforce start` 时不同，编译期校验过的层集与运行期不一定是同一套。启动时
// 层集对不上就 warn 一句「这些层未经编译期校验」，而不是假装校验过。
export interface LoggerLevelsSnapshot {
  /** 编译期见到的全部 logger 名，封闭名单。 */
  readonly names: readonly string[];
  /** 编译期可见的逐 logger 级别。 */
  readonly levels: Readonly<Record<string, LogThreshold>>;
  /** 未逐个指定时的兜底级别。 */
  readonly defaultLevel: LogThreshold;
  /** 编译期实际读过的 .env 层，按读取顺序。 */
  readonly layers: readonly string[];
}

const thresholdByName = new Map<string, LogThreshold>(
  // as：Object.keys 的返回类型恒为 string[]，键的字面量类型在这一步已经丢了。
  Object.keys(logThresholdValues).map((name) => [name, name as LogThreshold]),
);

// 收 `silent`：把一条 logger 彻底关掉是配置面最常用的动作，不收它等于让用户去猜一个
// 「比 fatal 还高」的词（RFC 0011 L1）。
export function parseLogThreshold(value: string | undefined): LogThreshold | undefined {
  return value === undefined ? undefined : thresholdByName.get(value.trim().toLowerCase());
}

// `LOGGING_LEVEL_<NAME>` 的 <NAME> 反解回 logger 名：走封闭名单的精确查表，不做盲展开，也
// 不经 @reforce/config 的 buildBindingInput——那条路上的 toLowerCase 会不可逆地丢掉大小写。
export function environmentKeyForLogger(name: string): string {
  return `LOGGING_LEVEL_${name.replaceAll(/[^A-Za-z0-9]/gu, "_").toUpperCase()}`;
}

export class LoggerLevels {
  private readonly snapshot: LoggerLevelsSnapshot;

  constructor(snapshot: LoggerLevelsSnapshot) {
    this.snapshot = snapshot;
  }

  get names(): readonly string[] {
    return this.snapshot.names;
  }

  get layers(): readonly string[] {
    return this.snapshot.layers;
  }

  get defaultLevel(): LogThreshold {
    return this.snapshot.defaultLevel;
  }

  levelFor(name: string, environment: Readonly<Record<string, string | undefined>>): LogThreshold {
    return this.explicitLevelFor(name, environment) ?? this.snapshot.defaultLevel;
  }

  // 与 levelFor 的区别是「没配就说没配」：绑定自己的缺省（pino 的 PinoSettings.level、默认
  // 绑定的 defaultLevel）是用户显式写下的，快照没有逐个指定这条 logger 时不该把它顶掉。
  // levelFor 保留兜底形态，供不带绑定缺省的调用方直接取一个确定级别。
  explicitLevelFor(
    name: string,
    environment: Readonly<Record<string, string | undefined>>,
  ): LogThreshold | undefined {
    // 运行期注入的键压过编译期快照：容器编排常在启动时才给出级别，编译期看不到它。
    return (
      parseLogThreshold(environment[environmentKeyForLogger(name)]) ?? this.snapshot.levels[name]
    );
  }

  // 运行期兜底（L5.5）：同一份封闭名单、同一个 did-you-mean，warn 但不阻止启动。
  unknownLoggerKeys(
    environment: Readonly<Record<string, string | undefined>>,
  ): readonly { readonly key: string; readonly suggestion?: string }[] {
    const known = new Map(this.snapshot.names.map((name) => [environmentKeyForLogger(name), name]));
    const unknown: { readonly key: string; readonly suggestion?: string }[] = [];
    for (const key of Object.keys(environment)) {
      if (!key.startsWith("LOGGING_LEVEL_") || known.has(key)) {
        continue;
      }
      const suggestion = nearestName(key, [...known.keys()]);
      unknown.push(suggestion === undefined ? { key } : { key, suggestion });
    }
    return unknown;
  }
}

// Levenshtein 距离 <4，平局取 UTF-16 序在前的那个——与 @reforce/config 的
// suggestEnvironmentName 同一套判据，两处给的建议不会互相矛盾。
function nearestName(key: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 4;
  for (const candidate of candidates) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance || (distance === bestDistance && candidate < (best ?? ""))) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution =
        (previous[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1);
      current[column] = Math.min(
        substitution,
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
      );
    }
    previous = current;
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}
