import type { SourceSpan } from "@reforce/compiler-spi";

interface SpannedRecord {
  readonly span: SourceSpan;
  readonly kind: string;
}

export function compareUtf16CodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const source = Object.entries(value).sort(([left], [right]) =>
    compareUtf16CodeUnits(left, right),
  );
  return Object.fromEntries(source.map(([key, nested]) => [key, stableValue(nested)]));
}

function stableStructuralKey(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function compareSpanned(left: SpannedRecord, right: SpannedRecord): number {
  const start = left.span.start.offset - right.span.start.offset;
  if (start !== 0) {
    return start;
  }
  const end = left.span.end.offset - right.span.end.offset;
  if (end !== 0) {
    return end;
  }
  const kind = compareUtf16CodeUnits(left.kind, right.kind);
  if (kind !== 0) {
    return kind;
  }
  return compareUtf16CodeUnits(stableStructuralKey(left), stableStructuralKey(right));
}

export function normalizeSpanned<T extends SpannedRecord>(values: readonly T[]): readonly T[] {
  const sorted = values.toSorted(compareSpanned);
  return sorted.filter((value, index) => {
    const previous = sorted[index - 1];
    return previous === undefined || stableStructuralKey(previous) !== stableStructuralKey(value);
  });
}
