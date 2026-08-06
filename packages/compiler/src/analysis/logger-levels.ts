import { compareUtf16CodeUnits } from "@reforce/primitives";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";

// `logging.level.*` 的编译期校验（RFC 0011 L5，#242）。
//
// 反解走封闭名单的精确查表，不经 @reforce/config 的 buildBindingInput——那条路上的 toLowerCase
// 会把 `payments.Gateway` 与 `payments.gateway` 变成同一个键，反解不回原名。

const loggingLevelPrefix = "LOGGING_LEVEL_";

// 与 @reforce/logging 的 environmentKeyForLogger 必须逐字一致：两侧算出不同的键名，编译期
// 校验过的键在运行期就查不到。
export function environmentKeyForLogger(name: string): string {
  return `${loggingLevelPrefix}${name.replaceAll(/[^A-Za-z0-9]/gu, "_").toUpperCase()}`;
}

// Levenshtein <4、平局取 UTF-16 序在前——与 config 的 suggestEnvironmentName 同一套判据，
// 两处给的建议不会互相矛盾。
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

function nearestKey(key: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 4;
  for (const candidate of [...candidates].toSorted(compareUtf16CodeUnits)) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

// severity 是 warning：级别写错一个名字，应用照样跑得起来，只是那条 logger 没按预期调级。
// 拦住编译反而会让「加一条日志顺手调级」变成一次构建失败。
export function validateLoggerLevelKeys(input: {
  readonly environmentKeys: ReadonlySet<string>;
  readonly loggerNames: readonly string[];
  readonly diagnostics: CompilerDiagnostic[];
}): void {
  const known = new Map(input.loggerNames.map((name) => [environmentKeyForLogger(name), name]));
  for (const key of [...input.environmentKeys].toSorted(compareUtf16CodeUnits)) {
    if (!key.startsWith(loggingLevelPrefix) || known.has(key)) {
      continue;
    }
    const suggestion = nearestKey(key, [...known.keys()]);
    input.diagnostics.push(
      diagnostic({
        code: "UNKNOWN_LOGGER_NAME",
        severity: "warning",
        message: `${key} does not name any logger in this application.`,
        help:
          suggestion === undefined
            ? `Known logger keys: ${[...known.keys()].toSorted(compareUtf16CodeUnits).join(", ") || "(none — no class injects a Logger yet)"}`
            : `Did you mean ${suggestion}?`,
      }),
    );
  }
}
