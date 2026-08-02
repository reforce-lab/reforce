import type {
  CompilerFrontend,
  FrontendDiagnostic,
  FrontendInput,
  FrontendResult,
} from "@reforce/compiler-spi";
import { parse, type SourceLang, type SourceType } from "yuku-parser";
import { lowerSourceUnit } from "#internal/lower-ir";
import { createSourceMapper } from "#internal/source-map";

function sourceLanguage(input: FrontendInput): SourceLang {
  if (input.sourceKind.startsWith("d.")) {
    return "dts";
  }
  return input.sourceKind === "tsx" ? "tsx" : "ts";
}

function sourceType(input: FrontendInput): SourceType {
  return input.sourceKind === "cts" || input.sourceKind === "d.cts" ? "commonjs" : "module";
}

function diagnosticsOf(
  input: FrontendInput,
  diagnostics: ReturnType<typeof parse>["diagnostics"],
): readonly FrontendDiagnostic[] {
  const mapper = createSourceMapper(input.file, input.sourceText);
  const earliest = diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .toSorted((left, right) => left.start - right.start || left.end - right.end)[0];
  if (earliest === undefined) {
    return [];
  }
  return [
    {
      kind: "frontend",
      code: "PARSER_SYNTAX_ERROR",
      severity: "error",
      message: "Source contains invalid TypeScript syntax.",
      sourceSpan: mapper.span(earliest.start, earliest.end),
      related: [],
    },
  ];
}

async function parseWithYuku(input: FrontendInput): Promise<FrontendResult> {
  try {
    const parsed = parse(input.sourceText, {
      sourceType: sourceType(input),
      lang: sourceLanguage(input),
      preserveParens: true,
      semanticErrors: false,
      attachComments: false,
    });
    const diagnostics = diagnosticsOf(input, parsed.diagnostics);
    if (diagnostics.length > 0) {
      return { diagnostics };
    }
    return {
      unit: lowerSourceUnit(input.file, input.sourceKind, input.sourceText, parsed.program),
      diagnostics: [],
    };
  } catch {
    return {
      diagnostics: [
        {
          kind: "frontend",
          code: "PARSER_SYNTAX_ERROR",
          severity: "error",
          message: "Source contains invalid TypeScript syntax.",
          sourceSpan: createSourceMapper(input.file, input.sourceText).span(0, 0),
          related: [],
        },
      ],
    };
  }
}

export const yukuFrontend = {
  id: "yuku",
  cacheKey: "yuku-adapter@1:yuku-parser@0.8.3:typescript-estree-decorators",
  parse: parseWithYuku,
} satisfies CompilerFrontend;
