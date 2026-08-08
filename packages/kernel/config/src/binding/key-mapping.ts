// 纯函数层：prefix/字段名与环境变量名之间的正反映射，无任何 I/O（ADR 0005）

// 词边界规则：连续大写作为缩写整体（后随小写时让出末位），其余按大写起始或小写数字段切词
const wordPattern = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g;

export function splitWords(name: string): readonly string[] {
  return Array.from(name.matchAll(wordPattern), (match) => match[0].toLowerCase());
}

export function camelJoin(words: readonly string[]): string {
  const [first = "", ...rest] = words;
  return (
    first.toLowerCase() + rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("")
  );
}

export function prefixWordsOf(prefix: string): readonly string[] {
  return prefix.split(".").flatMap((segment) => splitWords(segment));
}

// 前缀 → 环境变量名前缀。第三个调用点了（buildBindingInput、warnUnmatchedKeys、来源输出），
// 这是同一份知识而不是长得像的代码：改一处就得同步三处。
export function environmentKeyPrefix(prefixWords: readonly string[]): string {
  return `${prefixWords.join("_").toUpperCase()}_`;
}

export function environmentVariableName(
  prefix: string,
  path: readonly (string | number)[],
): string {
  const words = [...prefixWordsOf(prefix)];
  for (const segment of path) {
    if (typeof segment === "number") {
      words.push(String(segment));
      continue;
    }
    words.push(...splitWords(segment));
  }
  return words.join("_").toUpperCase();
}

// 反向盲展开：StandardSchemaV1 没有字段枚举能力，绑定时不知道 schema 的形状，
// 只能把 2^(n-1) 种词边界划分全部生成，保证任何正向映射等于该键的形状都能拿到值（ADR 0005）
export function expandKeyPaths(segments: readonly string[]): readonly (readonly string[])[] {
  const [firstSegment, ...restSegments] = segments;
  if (firstSegment === undefined) {
    return [];
  }
  // 指数展开的工作量上限：超过 12 段只保留两个极端（全并与全嵌套），
  // 真实配置键远小于该长度，超长键几乎必然是垃圾输入，不值得 4096+ 个候选
  if (segments.length > 12) {
    return [[camelJoin(segments)], [...segments]];
  }
  const paths: (readonly string[])[] = [];
  const total = 1 << restSegments.length;
  // gap 视为二进制计数器：bit=0 并入同一字段名，bit=1 断开为嵌套层；mask 0（全并）最先
  for (let mask = 0; mask < total; mask++) {
    const path: string[] = [];
    let group: string[] = [firstSegment];
    restSegments.forEach((segment, gap) => {
      if ((mask & (1 << gap)) === 0) {
        group.push(segment);
        return;
      }
      path.push(camelJoin(group));
      group = [segment];
    });
    path.push(camelJoin(group));
    paths.push(path);
  }
  return paths;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// 冲突规则：对象胜过标量（双向）。数字词让反向映射不单射（SERVER_RETRY2_MAX 与
// SERVER_RETRY_2 都会触碰 retry2），两个方向都会真实发生
function mergeCandidatePath(
  target: Record<string, unknown>,
  path: readonly string[],
  value: string,
): void {
  const leaf = path.at(-1);
  if (leaf === undefined) {
    return;
  }
  let node = target;
  for (const key of path.slice(0, -1)) {
    const existing = node[key];
    if (isPlainRecord(existing)) {
      node = existing;
      continue;
    }
    const next: Record<string, unknown> = {};
    node[key] = next;
    node = next;
  }
  if (isPlainRecord(node[leaf])) {
    return;
  }
  node[leaf] = value;
}

export function buildBindingInput(
  prefixWords: readonly string[],
  entries: ReadonlyMap<string, string>,
): object {
  const keyPrefix = environmentKeyPrefix(prefixWords);
  const input: Record<string, unknown> = {};
  // UTF-16 排序保证合并结果与 Map 插入顺序无关
  const sortedKeys = [...entries.keys()].sort();
  for (const key of sortedKeys) {
    if (!key.startsWith(keyPrefix)) {
      continue;
    }
    const remainder = key.slice(keyPrefix.length);
    if (remainder.length === 0) {
      continue;
    }
    const segments = remainder.split("_").map((segment) => segment.toLowerCase());
    const value = entries.get(key);
    if (value === undefined) {
      continue;
    }
    for (const path of expandKeyPaths(segments)) {
      mergeCandidatePath(input, path, value);
    }
  }
  return input;
}

function levenshteinDistance(left: string, right: string): number {
  let previousRow = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const currentRow = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      currentRow.push(
        Math.min(
          (previousRow[rightIndex] ?? 0) + 1,
          (currentRow[rightIndex - 1] ?? 0) + 1,
          (previousRow[rightIndex - 1] ?? 0) + substitutionCost,
        ),
      );
    }
    previousRow = currentRow;
  }
  return previousRow[right.length] ?? 0;
}

export function suggestEnvironmentName(
  unknownKey: string,
  knownKeys: readonly string[],
): string | undefined {
  let best: string | undefined;
  // 距离 >3 的建议弊大于利；并列时按 UTF-16 顺序取最小，保证输出确定
  let bestDistance = 4;
  for (const key of [...knownKeys].sort()) {
    const distance = levenshteinDistance(unknownKey, key);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = key;
    }
  }
  return best;
}
