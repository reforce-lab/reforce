import { compareUtf16CodeUnits } from "@reforce/primitives";
import type { CompilerDiagnostic } from "@/api";
import { stableStructuralKey } from "@/determinism";
import type { CompilerDiagnosticCode } from "@/error-codes";
import type { SourceSpan } from "@/parser/source-location";

type DiagnosticCause = NonNullable<CompilerDiagnostic["cause"]>;
type DiagnosticRelatedInformation = CompilerDiagnostic["related"][number];

interface DiagnosticInput {
  readonly code: CompilerDiagnosticCode;
  // 缺省仍是 error：绝大多数诊断意味着图不完整，把 severity 写成必填只会让 59 个构造点各抄
  // 一遍同一个值（RFC 0011 OM2，#242）。
  readonly severity?: CompilerDiagnostic["severity"] | undefined;
  readonly message: string;
  readonly sourceSpan?: SourceSpan | undefined;
  readonly related?: readonly DiagnosticRelatedInformation[] | undefined;
  readonly help?: string | undefined;
  readonly suggestions?: CompilerDiagnostic["suggestions"];
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
    // severity 排在 code 之前：同一处位置上 error 必须先于 warning 出现，读者先看到拦住编译的
    // 那一条。"error" < "warning" 在 UTF-16 序下天然成立，不需要额外的权重表。
    [left.severity, right.severity],
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
    severity: input.severity ?? "error",
    message: input.message,
    sourceSpan: input.sourceSpan,
    related: normalizeRelated(input.related ?? []),
    help: input.help,
    suggestions: input.suggestions,
    cause,
  });
}

// 「构造一条带位置的诊断并入账」的位置参数版：分析层大量诊断都是这个形状，各文件此前
// 各抄一份（web-routes / web-slots / method-interception 三份，其中只有 web-slots 那份带
// suggestions 并返回 undefined 以便写 `return report(...)`）。这里收成一份取超集。
export function report(
  diagnostics: CompilerDiagnostic[],
  code: CompilerDiagnosticCode,
  message: string,
  span: SourceSpan,
  // exactOptionalPropertyTypes 下三个键都写成 `| undefined`（#367）：调用点大量是
  // `{ help: maybeUndefined }`，收窄成 `?: string` 会逼它们各写一次条件展开。
  options: {
    readonly help?: string | undefined;
    readonly related?: CompilerDiagnostic["related"] | undefined;
    readonly suggestions?: CompilerDiagnostic["suggestions"] | undefined;
  } = {},
): undefined {
  diagnostics.push(
    diagnostic({
      code,
      message,
      sourceSpan: span,
      help: options.help,
      related: options.related,
      suggestions: options.suggestions,
    }),
  );
  return undefined;
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

// status 只看有没有 error：warning 随 success 一起返回，不构成失败（RFC 0011 OM2，#242）。
export function hasErrorDiagnostic(diagnostics: readonly CompilerDiagnostic[]): boolean {
  return diagnostics.some((item) => item.severity === "error");
}

export function errorDiagnostics(
  diagnostics: readonly CompilerDiagnostic[],
): readonly CompilerDiagnostic[] {
  return diagnostics.filter((item) => item.severity === "error");
}

export function warningDiagnostics(
  diagnostics: readonly CompilerDiagnostic[],
): readonly CompilerDiagnostic[] {
  return diagnostics.filter((item) => item.severity === "warning");
}
