import { unique } from "radashi";

export function compareUtf16CodeUnits(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

export function sortNativePaths(paths: Iterable<string>): readonly string[] {
  return Object.freeze(
    unique([...paths]).sort((left, right) => {
      const normalized = compareUtf16CodeUnits(
        left.replaceAll("\\", "/"),
        right.replaceAll("\\", "/"),
      );
      return normalized === 0 ? compareUtf16CodeUnits(left, right) : normalized;
    }),
  );
}

export function stableStructuralKey(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStructuralKey).join(",")}]`;
  }
  const record = value as Record<string, unknown>; // Runtime object validation is provided by Object.keys before recursive access.
  const entries = Object.keys(record)
    .sort(compareUtf16CodeUnits)
    .map((key) => `${JSON.stringify(key)}:${stableStructuralKey(record[key])}`);
  return `{${entries.join(",")}}`;
}
