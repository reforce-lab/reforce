import {
  type ProviderDraft,
  providerId,
  type QualifierModel,
  reportUnsupportedType,
  sourceReference,
} from "@/analysis/model";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { LinkedSymbol, ProjectLinker } from "@/linking/project-linker";
import type {
  DefineBeanDeclaration,
  DefineBeanOptionProperty,
  FunctionDescriptor,
} from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

function functionOption(
  properties: readonly DefineBeanOptionProperty[],
  kind: "create" | "dispose",
): FunctionDescriptor | undefined {
  const property = properties.find((item) => item.kind === kind);
  if (
    property?.kind !== kind ||
    (property.value.kind !== "arrow" && property.value.kind !== "function")
  ) {
    return undefined;
  }
  return property.value;
}

function literalOption(
  properties: readonly DefineBeanOptionProperty[],
  kind: "primary" | "qualifier",
): boolean | string | undefined {
  const property = properties.find((item) => item.kind === kind);
  if (property?.kind !== kind) {
    return undefined;
  }
  if (property.value.kind === "boolean-literal") {
    return property.value.value;
  }
  return property.value.kind === "string-literal" ? property.value.value : undefined;
}

interface FactoryProvidedType {
  readonly symbol: LinkedSymbol;
  readonly typeArgumentCount: number;
}

function resolveFactoryProvidedType(
  source: ParsedSource,
  declaration: DefineBeanDeclaration,
  create: FunctionDescriptor,
  linker: ProjectLinker,
): FactoryProvidedType | undefined {
  const candidate =
    declaration.typeArguments.length === 1 ? declaration.typeArguments[0] : create.returnType;
  if (candidate !== undefined) {
    const linked = linker.resolveType(source, candidate);
    return linked === undefined
      ? undefined
      : { symbol: linked.symbol, typeArgumentCount: linked.typeArguments.length };
  }
  if (create.body.kind !== "direct-new") {
    return undefined;
  }
  const symbol = linker.resolveEntity(source, create.body.callee);
  return symbol === undefined ? undefined : { symbol, typeArgumentCount: 0 };
}

function factoryExportName(
  declaration: DefineBeanDeclaration,
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  const exportName = declaration.name;
  if (
    declaration.topLevel &&
    declaration.declarationKind === "const" &&
    exportName !== undefined &&
    declaration.export.kind === "named" &&
    declaration.options.kind === "object"
  ) {
    return exportName;
  }
  diagnostics.push(
    diagnostic({
      code: "INVALID_DEFINE_BEAN",
      message:
        "defineBean must initialize a top-level direct named export const with an inline object.",
      sourceSpan: declaration.span,
      help: "Export const definition = defineBean({ create: ... }) directly.",
    }),
  );
  return undefined;
}

interface FactoryFunctions {
  readonly create: FunctionDescriptor;
  readonly dispose?: FunctionDescriptor;
}

function factoryFunctions(
  properties: readonly DefineBeanOptionProperty[],
  exportName: string,
  optionsSpan: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): FactoryFunctions | undefined {
  const knownKinds = ["create", "dispose", "primary", "qualifier"] as const;
  const duplicates = knownKinds.some(
    (kind) => properties.filter((property) => property.kind === kind).length > 1,
  );
  if (duplicates || properties.some((property) => property.kind === "unsupported-property")) {
    diagnostics.push(
      diagnostic({
        code: "INVALID_DEFINE_BEAN",
        message: `${exportName} has duplicate or unsupported defineBean options.`,
        sourceSpan: optionsSpan,
        help: "Use one each of create, dispose, primary, and qualifier with literal property names.",
      }),
    );
    return undefined;
  }
  const create = functionOption(properties, "create");
  if (create === undefined || create.async || create.parameterCount !== 0) {
    diagnostics.push(
      diagnostic({
        code: "INVALID_DEFINE_BEAN",
        message: `${exportName}.create must be a synchronous zero-parameter function.`,
        sourceSpan: optionsSpan,
        help: "Create the resource synchronously inside a zero-parameter create function.",
      }),
    );
    return undefined;
  }
  const dispose = functionOption(properties, "dispose");
  const hasDispose = properties.some((property) => property.kind === "dispose");
  if (hasDispose && dispose === undefined) {
    diagnostics.push(
      diagnostic({
        code: "INVALID_DEFINE_BEAN",
        message: `${exportName}.dispose must be an inline function.`,
        sourceSpan: optionsSpan,
        help: "Declare dispose(instance) inline or omit the option.",
      }),
    );
    return undefined;
  }
  if (dispose !== undefined && dispose.parameterCount !== 1) {
    diagnostics.push(
      diagnostic({
        code: "INVALID_DEFINE_BEAN",
        message: `${exportName}.dispose must accept exactly one instance parameter.`,
        sourceSpan: dispose.span,
        help: "Declare dispose(instance) with exactly one parameter.",
      }),
    );
    return undefined;
  }
  return dispose === undefined ? { create } : { create, dispose };
}

function validFactoryProvidedType(
  provided: FactoryProvidedType | undefined,
  declaration: DefineBeanDeclaration,
  exportName: string,
  diagnostics: CompilerDiagnostic[],
): provided is FactoryProvidedType {
  if (provided === undefined) {
    diagnostics.push(
      diagnostic({
        code: "INVALID_DEFINE_BEAN",
        message: `${exportName} must explicitly provide a non-generic object class or interface.`,
        sourceSpan: declaration.span,
        help: "Add defineBean<T>, a create return type, or a direct new expression.",
      }),
    );
    return false;
  }
  const symbol = provided.symbol;
  if (symbol.kind === "unsupported") {
    reportUnsupportedType(diagnostics, symbol, declaration.span);
    return false;
  }
  const supported =
    (symbol.kind === "class" || symbol.kind === "interface") &&
    !symbol.generic &&
    provided.typeArgumentCount === 0;
  if (supported) {
    return true;
  }
  diagnostics.push(
    diagnostic({
      code: "INVALID_DEFINE_BEAN",
      message: `${exportName} must explicitly provide a non-generic object class or interface.`,
      sourceSpan: declaration.span,
      help: "Add defineBean<T>, a create return type, or a direct new expression.",
    }),
  );
  return false;
}

interface FactoryLiteralOptions {
  readonly primary: boolean;
  readonly qualifiers: readonly QualifierModel[];
}

function factoryLiteralOptions(
  properties: readonly DefineBeanOptionProperty[],
  providedSymbol: LinkedSymbol,
  exportName: string,
  optionsSpan: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): FactoryLiteralOptions {
  const primaryValue = literalOption(properties, "primary");
  const qualifierValue = literalOption(properties, "qualifier");
  const hasPrimary = properties.some((property) => property.kind === "primary");
  const hasQualifier = properties.some((property) => property.kind === "qualifier");
  if (hasPrimary && typeof primaryValue !== "boolean") {
    diagnostics.push(
      diagnostic({
        code: "INVALID_DEFINE_BEAN",
        message: `${exportName}.primary must be a boolean literal.`,
        sourceSpan: optionsSpan,
        help: "Use primary: true, primary: false, or omit the option.",
      }),
    );
  }
  if (hasQualifier && typeof qualifierValue !== "string") {
    diagnostics.push(
      diagnostic({
        code: "INVALID_BEAN_QUALIFIER",
        message: `${exportName}.qualifier must be a string literal.`,
        sourceSpan: optionsSpan,
        help: "Use a valid TypeScript identifier string or omit the option.",
      }),
    );
  }
  const eligible =
    providedSymbol.kind === "interface" &&
    providedSymbol.source !== undefined &&
    providedSymbol.declaration?.kind === "interface" &&
    providedSymbol.declaration.export.kind === "named";
  if (hasQualifier && !eligible) {
    diagnostics.push(
      diagnostic({
        code: "INVALID_BEAN_QUALIFIER",
        message: `${exportName} cannot qualify a concrete or external provided type.`,
        sourceSpan: optionsSpan,
        help: "Provide an exported application interface or remove qualifier.",
      }),
    );
  }
  const qualifiers: QualifierModel[] = eligible
    ? [
        {
          interfaceSymbol: providedSymbol,
          member: typeof qualifierValue === "string" ? qualifierValue : exportName,
        },
      ]
    : [];
  return { primary: primaryValue === true, qualifiers };
}

export function analyzeFactoryProvider(
  source: ParsedSource,
  declaration: DefineBeanDeclaration,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): ProviderDraft | undefined {
  const callee = linker.resolveEntity(source, declaration.callee);
  if (callee?.kind !== "context" || callee.name !== "defineBean") {
    return undefined;
  }
  const exportName = factoryExportName(declaration, diagnostics);
  if (exportName === undefined || declaration.options.kind !== "object") {
    return undefined;
  }
  if (declaration.typeArguments.length > 1) {
    diagnostics.push(
      diagnostic({
        code: "INVALID_DEFINE_BEAN",
        message: `${exportName} must have at most one explicit provided type argument.`,
        sourceSpan: declaration.span,
        help: "Pass exactly one provided type or omit it for supported create inference.",
      }),
    );
    return undefined;
  }

  const properties = declaration.options.properties;
  const functions = factoryFunctions(properties, exportName, declaration.options.span, diagnostics);
  if (functions === undefined) {
    return undefined;
  }
  const provided = resolveFactoryProvidedType(source, declaration, functions.create, linker);
  if (!validFactoryProvidedType(provided, declaration, exportName, diagnostics)) {
    return undefined;
  }
  const providedSymbol = provided.symbol;
  const literalOptions = factoryLiteralOptions(
    properties,
    providedSymbol,
    exportName,
    declaration.options.span,
    diagnostics,
  );
  return {
    provider: {
      kind: "factory",
      id: providerId(source.fileId, exportName),
      source,
      exportName,
      declarationSource: sourceReference(declaration.span),
      provides: [providedSymbol],
      primary: literalOptions.primary,
      qualifiers: literalOptions.qualifiers,
      dependencies: [],
      dispose: functions.dispose !== undefined,
    },
    pendingDependencies: [],
  };
}
