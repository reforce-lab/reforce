import { type ParserOptions, type ParserPlugin, parse } from "@babel/parser";
import type {
  CompilerFrontend,
  FrontendDiagnostic,
  FrontendInput,
  FrontendResult,
} from "@reforce/compiler-spi";
import { lowerSourceUnit } from "#internal/lower-ir";
import { createSourceMapper } from "#internal/source-map";

interface ParserErrorData {
  readonly message: string;
  readonly position: number;
  readonly reason?: string;
}

function parserOptions(input: FrontendInput): ParserOptions {
  const plugins: ParserPlugin[] = [
    ["decorators", { decoratorsBeforeExport: true }],
    "decoratorAutoAccessors",
    "estree",
    ["typescript", { dts: input.sourceKind.startsWith("d.") }],
  ];
  if (input.sourceKind === "tsx") {
    plugins.push("jsx");
  }
  return {
    sourceType: input.sourceKind === "cts" || input.sourceKind === "d.cts" ? "commonjs" : "module",
    errorRecovery: true,
    allowUndeclaredExports: true,
    plugins,
  };
}

function errorData(error: unknown): ParserErrorData {
  if (error instanceof Error) {
    const position = "pos" in error && typeof error.pos === "number" ? error.pos : 0;
    const reason =
      "reasonCode" in error && typeof error.reasonCode === "string" ? error.reasonCode : undefined;
    return { message: error.message, position, reason };
  }
  return { message: "Source contains invalid TypeScript syntax.", position: 0 };
}

function isRecoverableSemanticGrammar(error: ParserErrorData): boolean {
  return error.reason === "UnsupportedParameterDecorator";
}

function diagnosticsOf(
  input: FrontendInput,
  errors: readonly unknown[],
): readonly FrontendDiagnostic[] {
  const mapper = createSourceMapper(input.file, input.sourceText);
  const diagnostics = errors.map(errorData).filter((error) => !isRecoverableSemanticGrammar(error));
  const earliest = diagnostics.toSorted((left, right) => left.position - right.position)[0];
  if (earliest === undefined) {
    return [];
  }
  const end = Math.min(earliest.position + 1, input.sourceText.length);
  return [
    {
      kind: "frontend",
      code: "PARSER_SYNTAX_ERROR",
      severity: "error",
      message: "Source contains invalid TypeScript syntax.",
      sourceSpan: mapper.span(earliest.position, end),
      related: [],
    },
  ];
}

async function parseWithBabel(input: FrontendInput): Promise<FrontendResult> {
  try {
    const parsed = parse(input.sourceText, parserOptions(input));
    const diagnostics = diagnosticsOf(input, parsed.errors ?? []);
    if (diagnostics.length > 0) {
      return { diagnostics };
    }
    return {
      unit: lowerSourceUnit(input.file, input.sourceKind, input.sourceText, parsed.program),
      diagnostics: [],
    };
  } catch (error) {
    return { diagnostics: diagnosticsOf(input, [error]) };
  }
}

export const babelFrontend = {
  id: "babel",
  cacheKey: "babel-adapter@1:@babel/parser@7.29.8:estree-typescript-decorators",
  parse: parseWithBabel,
} satisfies CompilerFrontend;
