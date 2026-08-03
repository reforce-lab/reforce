import { compareUtf16CodeUnits } from "@reforce/primitives";
import { stableStructuralKey } from "@/determinism";
import type { SourceSpan } from "@/parser/source-location";

interface SpannedRecord {
  readonly span: SourceSpan;
  readonly kind: string;
}

function compareSpanned(left: SpannedRecord, right: SpannedRecord): number {
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
