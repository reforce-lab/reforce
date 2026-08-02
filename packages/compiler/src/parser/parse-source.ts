import { parse, type SourceLang, type SourceType } from "yuku-parser";
import { diagnostic } from "../diagnostics";
import type { CompilerDiagnostic } from "../types";
import { lowerSourceUnit } from "./lower-source";
import type { SourceKind, SourceUnit } from "./source-ir";
import { type CanonicalFileId, createSourceMapper } from "./source-location";

export interface ParseSourceInput {
  readonly file: CanonicalFileId;
  readonly sourceText: string;
  readonly sourceKind: SourceKind;
}

export type ParseSourceResult =
  | { readonly status: "success"; readonly unit: SourceUnit }
  | {
      readonly status: "failure";
      readonly diagnostics: readonly [CompilerDiagnostic, ...CompilerDiagnostic[]];
    };

function sourceLanguage(sourceKind: SourceKind): SourceLang {
  if (sourceKind.startsWith("d.")) {
    return "dts";
  }
  return sourceKind === "tsx" ? "tsx" : "ts";
}

function sourceType(sourceKind: SourceKind): SourceType {
  return sourceKind === "cts" || sourceKind === "d.cts" ? "commonjs" : "module";
}

function syntaxFailure(input: ParseSourceInput, start: number, end: number): ParseSourceResult {
  return {
    status: "failure",
    diagnostics: [
      diagnostic({
        code: "PARSER_SYNTAX_ERROR",
        message: "Source contains invalid TypeScript syntax.",
        sourceSpan: createSourceMapper(input.file, input.sourceText).span(start, end),
      }),
    ],
  };
}

export function parseSource(input: ParseSourceInput): ParseSourceResult {
  try {
    const parsed = parse(input.sourceText, {
      sourceType: sourceType(input.sourceKind),
      lang: sourceLanguage(input.sourceKind),
      preserveParens: true,
      semanticErrors: false,
      attachComments: false,
    });
    const earliest = parsed.diagnostics
      .filter((item) => item.severity === "error")
      .toSorted((left, right) => left.start - right.start || left.end - right.end)[0];
    if (earliest !== undefined) {
      return syntaxFailure(input, earliest.start, earliest.end);
    }
    return {
      status: "success",
      unit: lowerSourceUnit(input.file, input.sourceKind, input.sourceText, parsed.program),
    };
  } catch {
    return syntaxFailure(input, 0, 0);
  }
}
