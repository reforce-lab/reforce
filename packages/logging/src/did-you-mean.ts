// Levenshtein 距离 <4，平局取 UTF-16 序在前的那个——与 @reforce/config 的
// suggestEnvironmentName 同一套判据，两处给的建议不会互相矛盾。
export function nearestName(key: string, candidates: readonly string[]): string | undefined {
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
