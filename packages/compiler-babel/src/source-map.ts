import type { CanonicalFileId, SourcePosition, SourceSpan } from "@reforce/compiler-spi";

export interface SourceMapper {
  readonly span: (start: number, end: number) => SourceSpan;
}

function lineStartsOf(sourceText: string): readonly number[] {
  const starts = [0];
  let offset = 0;
  while (offset < sourceText.length) {
    const code = sourceText.charCodeAt(offset);
    if (code === 13 && sourceText.charCodeAt(offset + 1) === 10) {
      offset += 2;
      starts.push(offset);
      continue;
    }
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) {
      offset += 1;
      starts.push(offset);
      continue;
    }
    offset += 1;
  }
  return starts;
}

function positionAt(offset: number, lineStarts: readonly number[]): SourcePosition {
  let low = 0;
  let high = lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    const start = lineStarts[middle];
    if (start !== undefined && start <= offset) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return {
    offset,
    line: low,
    character: offset - (lineStarts[low] ?? 0),
  };
}

export function createSourceMapper(fileId: CanonicalFileId, sourceText: string): SourceMapper {
  const lineStarts = lineStartsOf(sourceText);
  return {
    span(start, end) {
      return {
        fileId,
        start: positionAt(start, lineStarts),
        end: positionAt(end, lineStarts),
      };
    },
  };
}
