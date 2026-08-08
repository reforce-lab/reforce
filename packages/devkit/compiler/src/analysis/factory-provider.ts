import {
  type ProviderDraft,
  providerId,
  type QualifierModel,
  reportUnsupportedType,
  sourceReference,
} from "@/analysis/model";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { LinkedSymbol } from "@/linking/model";
import type { ProjectLinker } from "@/linking/project-linker";
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
  kind: "primary" | "qualifier" | "scope",
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

// 请求作用域工厂允许 async create（ADR 0006 W7：请求计划本就在异步链里执行，await 照计划
// 串行）；singleton 工厂保持同步——这是两种 scope 的规则性差异，不是遗漏。
function factoryScope(
  properties: readonly DefineBeanOptionProperty[],
  exportName: string,
  optionsSpan: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): { readonly scope: "singleton" | "request"; readonly valid: boolean } {
  if (!properties.some((property) => property.kind === "scope")) {
    return { scope: "singleton", valid: true };
  }
  if (literalOption(properties, "scope") === "request") {
    return { scope: "request", valid: true };
  }
  diagnostics.push(
    diagnostic({
      code: "INVALID_DEFINE_BEAN",
      message: `${exportName}.scope must be the string literal "request" or be omitted.`,
      sourceSpan: optionsSpan,
      help: 'Declare scope: "request" for a request-scoped Bean; singleton is the default.',
    }),
  );
  return { scope: "singleton", valid: false };
}

function factoryCreateOption(
  properties: readonly DefineBeanOptionProperty[],
  scope: "singleton" | "request",
  exportName: string,
  optionsSpan: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): FunctionDescriptor | undefined {
  const create = functionOption(properties, "create");
  if (
    create !== undefined &&
    create.parameterCount === 0 &&
    (!create.async || scope === "request")
  ) {
    return create;
  }
  diagnostics.push(
    diagnostic({
      code: "INVALID_DEFINE_BEAN",
      message:
        scope === "request"
          ? `${exportName}.create must be a zero-parameter function.`
          : `${exportName}.create must be a synchronous zero-parameter function.`,
      sourceSpan: optionsSpan,
      help:
        scope === "request"
          ? "Create the request value inside a zero-parameter create function; async is allowed."
          : "Create the resource synchronously inside a zero-parameter create function.",
    }),
  );
  return undefined;
}

interface FactoryDisposeSelection {
  readonly valid: boolean;
  readonly dispose?: FunctionDescriptor;
}

function factoryDisposeOption(
  properties: readonly DefineBeanOptionProperty[],
  scope: "singleton" | "request",
  exportName: string,
  optionsSpan: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): FactoryDisposeSelection {
  const hasDispose = properties.some((property) => property.kind === "dispose");
  if (!hasDispose) {
    return { valid: true };
  }
  // 请求实例的生命随请求结束，没有 context 级 cleanup 相位可挂（ADR 0006 W7）。
  if (scope === "request") {
    diagnostics.push(
      diagnostic({
        code: "INVALID_DEFINE_BEAN",
        message: `${exportName} cannot declare dispose on a request-scoped factory.`,
        sourceSpan: optionsSpan,
        help: "Remove dispose: request instances end with their request, not with the context.",
      }),
    );
    return { valid: false };
  }
  const dispose = functionOption(properties, "dispose");
  if (dispose === undefined) {
    diagnostics.push(
      diagnostic({
        code: "INVALID_DEFINE_BEAN",
        message: `${exportName}.dispose must be an inline function.`,
        sourceSpan: optionsSpan,
        help: "Declare dispose(instance) inline or omit the option.",
      }),
    );
    return { valid: false };
  }
  if (dispose.parameterCount !== 1) {
    diagnostics.push(
      diagnostic({
        code: "INVALID_DEFINE_BEAN",
        message: `${exportName}.dispose must accept exactly one instance parameter.`,
        sourceSpan: dispose.span,
        help: "Declare dispose(instance) with exactly one parameter.",
      }),
    );
    return { valid: false };
  }
  return { valid: true, dispose };
}

function factoryFunctions(
  properties: readonly DefineBeanOptionProperty[],
  scope: "singleton" | "request",
  exportName: string,
  optionsSpan: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): FactoryFunctions | undefined {
  const knownKinds = ["create", "dispose", "primary", "qualifier", "scope"] as const;
  const duplicates = knownKinds.some(
    (kind) => properties.filter((property) => property.kind === kind).length > 1,
  );
  if (duplicates || properties.some((property) => property.kind === "unsupported-property")) {
    diagnostics.push(
      diagnostic({
        code: "INVALID_DEFINE_BEAN",
        message: `${exportName} has duplicate or unsupported defineBean options.`,
        sourceSpan: optionsSpan,
        help: "Use one each of create, dispose, primary, qualifier, and scope with literal property names.",
      }),
    );
    return undefined;
  }
  const create = factoryCreateOption(properties, scope, exportName, optionsSpan, diagnostics);
  if (create === undefined) {
    return undefined;
  }
  const disposeSelection = factoryDisposeOption(
    properties,
    scope,
    exportName,
    optionsSpan,
    diagnostics,
  );
  if (!disposeSelection.valid) {
    return undefined;
  }
  return disposeSelection.dispose === undefined
    ? { create }
    : { create, dispose: disposeSelection.dispose };
}

function validFactoryProvidedType(
  provided: FactoryProvidedType | undefined,
  declaration: DefineBeanDeclaration,
  exportName: string,
  linkFailureReported: boolean,
  diagnostics: CompilerDiagnostic[],
): provided is FactoryProvidedType {
  if (provided === undefined) {
    if (!linkFailureReported) {
      diagnostics.push(
        diagnostic({
          code: "INVALID_DEFINE_BEAN",
          message: `${exportName} must explicitly provide a non-generic object class or interface.`,
          sourceSpan: declaration.span,
          help: "Add defineBean<T>, a create return type, or a direct new expression.",
        }),
      );
    }
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
  if (callee?.kind !== "core" || callee.name !== "defineBean") {
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
  const scopeSelection = factoryScope(
    properties,
    exportName,
    declaration.options.span,
    diagnostics,
  );
  if (!scopeSelection.valid) {
    return undefined;
  }
  const functions = factoryFunctions(
    properties,
    scopeSelection.scope,
    exportName,
    declaration.options.span,
    diagnostics,
  );
  if (functions === undefined) {
    return undefined;
  }
  // The linker records its own diagnostic when it cannot link the provided type, but stays silent
  // on the shapes it never links; only report INVALID_DEFINE_BEAN when it said nothing (#108).
  const diagnosticCount = linker.diagnostics.length;
  const provided = resolveFactoryProvidedType(source, declaration, functions.create, linker);
  const linkFailureReported = linker.diagnostics.length > diagnosticCount;
  if (
    !validFactoryProvidedType(provided, declaration, exportName, linkFailureReported, diagnostics)
  ) {
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
      origin: { kind: "application", source },
      exportName,
      declarationSource: sourceReference(declaration.span),
      provides: [providedSymbol],
      scope: scopeSelection.scope,
      primary: literalOptions.primary,
      qualifiers: literalOptions.qualifiers,
      dependencies: [],
      dispose: functions.dispose !== undefined,
    },
    pendingDependencies: [],
  };
}
