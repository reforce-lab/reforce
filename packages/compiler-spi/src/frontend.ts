import type { SourceUnit } from "#internal/source-ir";
import type { CanonicalFileId, SourceSpan } from "#internal/source-location";

export type FrontendSourceKind = "ts" | "tsx" | "mts" | "cts" | "d.ts" | "d.mts" | "d.cts";

export interface FrontendInput {
  readonly file: CanonicalFileId;
  readonly sourceText: string;
  readonly sourceKind: FrontendSourceKind;
}

export interface FrontendDiagnosticRelatedInformation {
  readonly message: string;
  readonly sourceSpan?: SourceSpan;
}

export interface FrontendDiagnosticCause {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

export type FrontendDiagnosticCode = "PARSER_SYNTAX_ERROR";

export interface FrontendDiagnostic {
  readonly kind: "frontend";
  readonly code: FrontendDiagnosticCode;
  readonly severity: "error";
  readonly message: string;
  readonly sourceSpan?: SourceSpan;
  readonly related: readonly FrontendDiagnosticRelatedInformation[];
  readonly help?: string;
  readonly cause?: FrontendDiagnosticCause;
}

export interface FrontendResult {
  readonly unit?: SourceUnit;
  readonly diagnostics: readonly FrontendDiagnostic[];
}

export interface CompilerFrontend {
  readonly id: string;
  readonly cacheKey: string;
  parse(input: FrontendInput): Promise<FrontendResult>;
}
