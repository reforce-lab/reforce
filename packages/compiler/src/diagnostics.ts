import { compareUtf16CodeUnits } from "@reforce/primitives";
import type { CompilerDiagnostic, CompilerDiagnosticCode } from "@/api";
import { stableStructuralKey } from "@/determinism";
import type { SourceSpan } from "@/parser/source-location";

type DiagnosticCause = NonNullable<CompilerDiagnostic["cause"]>;
type DiagnosticRelatedInformation = CompilerDiagnostic["related"][number];

interface DiagnosticInput {
  readonly code: CompilerDiagnosticCode;
  readonly message: string;
  readonly sourceSpan?: SourceSpan;
  readonly related?: readonly DiagnosticRelatedInformation[];
  readonly help?: string;
  readonly cause?: unknown;
}

function normalizeCause(cause: unknown): DiagnosticCause | undefined {
  if (!(cause instanceof Error)) {
    return undefined;
  }

  const errorCode = Reflect.get(cause, "code");
  return {
    name: cause.name,
    message: cause.message,
    code: typeof errorCode === "string" ? errorCode : undefined,
  };
}

function normalizeRelated(
  related: readonly DiagnosticRelatedInformation[],
): readonly DiagnosticRelatedInformation[] {
  const unique = new Map<string, DiagnosticRelatedInformation>();
  for (const item of related) {
    unique.set(stableStructuralKey(item), item);
  }
  return Object.freeze([...unique.values()].toSorted(compareRelatedInformation));
}

function compareRelatedInformation(
  left: DiagnosticRelatedInformation,
  right: DiagnosticRelatedInformation,
): number {
  const leftSpan = left.sourceSpan;
  const rightSpan = right.sourceSpan;
  const spanPresence = Number(leftSpan === undefined) - Number(rightSpan === undefined);
  if (spanPresence !== 0) {
    return spanPresence;
  }
  const fields: readonly [string | number, string | number][] = [
    [leftSpan?.fileId ?? "", rightSpan?.fileId ?? ""],
    [leftSpan?.start.offset ?? -1, rightSpan?.start.offset ?? -1],
    [leftSpan?.end.offset ?? -1, rightSpan?.end.offset ?? -1],
    [left.message, right.message],
  ];
  for (const [leftField, rightField] of fields) {
    const compared =
      typeof leftField === "number" && typeof rightField === "number"
        ? leftField - rightField
        : compareUtf16CodeUnits(String(leftField), String(rightField));
    if (compared !== 0) {
      return compared;
    }
  }
  return compareUtf16CodeUnits(stableStructuralKey(left), stableStructuralKey(right));
}

function compareDiagnostics(left: CompilerDiagnostic, right: CompilerDiagnostic): number {
  const leftSpan = left.sourceSpan;
  const rightSpan = right.sourceSpan;
  const spanPresence = Number(leftSpan === undefined) - Number(rightSpan === undefined);
  if (spanPresence !== 0) {
    return spanPresence;
  }
  const fields: readonly [string | number, string | number][] = [
    [leftSpan?.fileId ?? "", rightSpan?.fileId ?? ""],
    [leftSpan?.start.offset ?? -1, rightSpan?.start.offset ?? -1],
    [leftSpan?.end.offset ?? -1, rightSpan?.end.offset ?? -1],
    [left.code, right.code],
    [left.message, right.message],
    [left.help ?? "", right.help ?? ""],
  ];
  for (const [leftField, rightField] of fields) {
    const compared =
      typeof leftField === "number" && typeof rightField === "number"
        ? leftField - rightField
        : compareUtf16CodeUnits(String(leftField), String(rightField));
    if (compared !== 0) {
      return compared;
    }
  }
  return compareUtf16CodeUnits(stableStructuralKey(left), stableStructuralKey(right));
}

export function diagnostic(input: DiagnosticInput): CompilerDiagnostic {
  const cause = normalizeCause(input.cause);
  return Object.freeze({
    kind: "compiler",
    code: input.code,
    severity: "error",
    message: input.message,
    sourceSpan: input.sourceSpan,
    related: normalizeRelated(input.related ?? []),
    help: input.help,
    cause,
  });
}

export function orderDiagnostics(
  diagnostics: readonly CompilerDiagnostic[],
): readonly CompilerDiagnostic[] {
  const unique = new Map<string, CompilerDiagnostic>();
  for (const item of diagnostics) {
    unique.set(stableStructuralKey(item), item);
  }
  return Object.freeze([...unique.values()].toSorted(compareDiagnostics));
}
