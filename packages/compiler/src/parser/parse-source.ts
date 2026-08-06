import { parse, type SourceLang, type SourceType } from "yuku-parser";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import { lowerSource } from "@/parser/lower-source";
import type { SourceFileIr, SourceKind } from "@/parser/source-ir";
import { type CanonicalFileId, createSourceMapper } from "@/parser/source-location";

export interface ParseSourceInput {
  readonly file: CanonicalFileId;
  readonly sourceText: string;
  readonly sourceKind: SourceKind;
}

export type ParseSourceResult =
  | { readonly status: "success"; readonly unit: SourceFileIr }
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
      // Pinned rather than inherited: lowering is written against an AST that still contains
      // `ParenthesizedExpression` and unwraps it itself (see `unparenthesized` in lower-values), so
      // the flag must not follow whatever the parser happens to default to.
      preserveParens: true,
      semanticErrors: false,
      // 保持 false：抑制注释从 parsed.comments 的平铺列表读，那份数据与本开关无关且恒带
      // offset；attachComments: true 交出的 AttachedComment 反而没有 offset（RFC 0011 D7，#242）。
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
      unit: lowerSource(input.file, input.sourceText, parsed.program, parsed.comments),
    };
  } catch {
    return syntaxFailure(input, 0, 0);
  }
}
