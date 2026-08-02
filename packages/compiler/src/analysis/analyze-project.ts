import type {
  ClassDeclaration,
  ClassMethodDeclaration,
  DecoratorUse,
  DefineBeanDeclaration,
  DefineBeanOptionProperty,
  FunctionDescriptor,
  NamespaceExportedMember,
  SourceSpan,
  TypeNode,
} from "@reforce/compiler-spi";
import { compareUtf16CodeUnits } from "../determinism";
import { diagnostic } from "../diagnostics";
import type { LinkedSymbol, LinkedType, Linker } from "../linking/module-graph";
import type { ParsedSource } from "../project/source-files";
import type { CompilerDiagnostic, DiagnosticRelatedInformation } from "../types";
import { createExecutionPlans } from "./graph-plan";
import {
  type ExecutionPlansModel,
  type ProviderModel,
  type QualifierModel,
  sourceReference,
} from "./model";
import { validQualifierName } from "./qualifier-name";

interface PendingDependency {
  readonly index: number;
  readonly linkedType: LinkedType;
  readonly sourceSpan: SourceSpan;
}

interface ProviderDraft {
  readonly provider: ProviderModel;
  readonly pendingDependencies: readonly PendingDependency[];
}

export interface AnalysisSuccess {
  readonly status: "success";
  readonly providers: readonly ProviderModel[];
  readonly plans: ExecutionPlansModel;
}

export interface AnalysisFailure {
  readonly status: "failure";
  readonly diagnostics: readonly [CompilerDiagnostic, ...CompilerDiagnostic[]];
}

export type AnalysisResult = AnalysisSuccess | AnalysisFailure;

function isEntityDecorator(decorator: DecoratorUse): decorator is DecoratorUse & {
  readonly callee: Exclude<DecoratorUse["callee"], { readonly kind: "unsupported-expression" }>;
} {
  return decorator.callee.kind !== "unsupported-expression";
}

function contextDecorators(
  source: ParsedSource,
  decorators: readonly DecoratorUse[],
  linker: Linker,
): ReadonlyMap<string, readonly DecoratorUse[]> {
  const result = new Map<string, DecoratorUse[]>();
  for (const decorator of decorators) {
    if (!isEntityDecorator(decorator)) {
      continue;
    }
    const symbol = linker.resolveEntity(source, decorator.callee);
    if (symbol?.kind !== "context") {
      continue;
    }
    const existing = result.get(symbol.name) ?? [];
    existing.push(decorator);
    result.set(symbol.name, existing);
  }
  return result;
}

function stringDecoratorArgument(decorator: DecoratorUse): string | undefined {
  const argument = decorator.arguments.at(0);
  return argument?.kind === "string-literal" && decorator.arguments.length === 1
    ? argument.value
    : undefined;
}

function methodName(method: ClassMethodDeclaration): string | undefined {
  if (method.name.kind === "identifier") {
    return method.name.name.text;
  }
  return method.name.kind === "string-literal" ? method.name.value : undefined;
}

function isVoidType(type: TypeNode | undefined): boolean {
  return type?.kind === "primitive" && type.name === "void";
}

function isPromiseVoidType(type: TypeNode | undefined): boolean {
  if (
    type?.kind !== "reference" ||
    type.name.kind !== "identifier" ||
    type.name.name.text !== "Promise" ||
    type.typeArguments.length !== 1
  ) {
    return false;
  }
  return isVoidType(type.typeArguments[0]);
}

function validLifecycleReturn(method: ClassMethodDeclaration): boolean {
  return method.async
    ? isPromiseVoidType(method.returnType)
    : isVoidType(method.returnType) || isPromiseVoidType(method.returnType);
}

function validLifecycleMethod(methods: readonly ClassMethodDeclaration[], name: string): boolean {
  const ambiguousComputedCandidate = methods.some(
    (method) =>
      method.name.kind === "computed" &&
      method.static === false &&
      method.accessibility === "public" &&
      method.generator === false &&
      method.optional === false &&
      method.implementation === true &&
      method.parameters.length === 0 &&
      validLifecycleReturn(method),
  );
  if (ambiguousComputedCandidate) {
    return false;
  }
  const candidates = methods.filter((method) => methodName(method) === name);
  return (
    candidates.length === 1 &&
    candidates[0]?.static === false &&
    candidates[0]?.accessibility === "public" &&
    candidates[0]?.generator === false &&
    candidates[0]?.optional === false &&
    candidates[0]?.implementation === true &&
    candidates[0]?.parameters.length === 0 &&
    validLifecycleReturn(candidates[0])
  );
}

function dedupeSymbols(symbols: readonly LinkedSymbol[]): readonly LinkedSymbol[] {
  const byKey = new Map<string, LinkedSymbol>();
  for (const symbol of symbols) {
    byKey.set(symbol.key, symbol);
  }
  return [...byKey.values()].sort((left, right) => compareUtf16CodeUnits(left.key, right.key));
}

function expandProvidedInterface(
  symbol: LinkedSymbol,
  linker: Linker,
  diagnostics: CompilerDiagnostic[],
  visited = new Set<string>(),
): readonly LinkedSymbol[] {
  if (visited.has(symbol.key)) {
    return [];
  }
  visited.add(symbol.key);
  const source = symbol.source;
  if (symbol.kind !== "interface") {
    return [];
  }
  if (source === undefined) {
    return [symbol];
  }
  if (symbol.declaration?.kind !== "interface") {
    return [];
  }
  const parents = symbol.declaration.extends.flatMap((type) => {
    const diagnosticCount = linker.diagnostics.length;
    const linked = linker.resolveType(source, type);
    if (linked === undefined) {
      if (linker.diagnostics.length === diagnosticCount) {
        diagnostics.push(
          diagnostic({
            code: "TYPE_LINK_FAILED",
            message: `Cannot link a parent interface of ${symbol.name}.`,
            sourceSpan: type.span,
            help: "Extend only directly linked non-generic application interfaces.",
          }),
        );
      }
      return [];
    }
    if (linked.symbol.kind === "unsupported") {
      reportUnsupportedType(diagnostics, linked.symbol, type.span);
      return [];
    }
    if (linked.symbol.generic || linked.typeArguments.length > 0) {
      diagnostics.push(
        diagnostic({
          code: "UNSUPPORTED_GENERIC_INTERFACE",
          message: `Parent interface ${linked.symbol.name} cannot use generic arguments.`,
          sourceSpan: type.span,
          help: "Extend a non-generic application interface.",
        }),
      );
      return [];
    }
    if (
      linked.symbol.kind !== "interface" ||
      linked.symbol.source === undefined ||
      linked.symbol.declaration?.kind !== "interface"
    ) {
      diagnostics.push(
        diagnostic({
          code: "TYPE_LINK_FAILED",
          message: `Parent ${linked.symbol.name} is not an application interface.`,
          sourceSpan: type.span,
          help: "Extend only directly linked non-generic application interfaces.",
        }),
      );
      return [];
    }
    return expandProvidedInterface(linked.symbol, linker, diagnostics, visited);
  });
  return [symbol, ...parents];
}

function nonEmptyDiagnostics(
  diagnostics: readonly CompilerDiagnostic[],
): readonly [CompilerDiagnostic, ...CompilerDiagnostic[]] {
  const first = diagnostics[0];
  if (first === undefined) {
    throw new Error("Expected at least one diagnostic");
  }
  return [first, ...diagnostics.slice(1)];
}

function addInvalidDecoratorDiagnostic(
  diagnostics: CompilerDiagnostic[],
  message: string,
  span: SourceSpan,
): void {
  diagnostics.push(
    diagnostic({
      code: "INVALID_DECORATOR_USAGE",
      message,
      sourceSpan: span,
      help: "Use each Reforce decorator once with its documented literal arguments.",
    }),
  );
}

interface ClassDecoratorSelection {
  readonly primary: boolean;
  readonly qualifierDecorators: readonly DecoratorUse[];
  readonly explicitQualifier?: string;
}

function validatePrimaryDecorators(
  decorators: readonly DecoratorUse[],
  declaration: ClassDeclaration,
  diagnostics: CompilerDiagnostic[],
): void {
  const invalid =
    decorators.length > 1 ||
    decorators.some((decorator) => !decorator.called || decorator.arguments.length !== 0);
  if (!invalid) {
    return;
  }
  addInvalidDecoratorDiagnostic(
    diagnostics,
    "Primary must appear at most once as @Primary().",
    decorators[0]?.span ?? declaration.span,
  );
}

function explicitQualifierFrom(
  decorators: readonly DecoratorUse[],
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  const first = decorators.at(0);
  if (first === undefined) {
    return undefined;
  }
  const value = stringDecoratorArgument(first);
  if (decorators.length !== 1 || !first.called || value === undefined) {
    addInvalidDecoratorDiagnostic(
      diagnostics,
      "Qualifier must appear at most once with one string literal.",
      first.span,
    );
  }
  return value;
}

function classDecoratorSelection(
  source: ParsedSource,
  declaration: ClassDeclaration,
  linker: Linker,
  diagnostics: CompilerDiagnostic[],
): ClassDecoratorSelection | undefined {
  const decorators = contextDecorators(source, declaration.decorators, linker);
  const injectable = decorators.get("Injectable") ?? [];
  const primaryDecorators = decorators.get("Primary") ?? [];
  const qualifierDecorators = decorators.get("Qualifier") ?? [];
  if (injectable.length === 0) {
    for (const decorator of [...primaryDecorators, ...qualifierDecorators]) {
      addInvalidDecoratorDiagnostic(
        diagnostics,
        "Primary and Qualifier can only mark an Injectable class.",
        decorator.span,
      );
    }
    return undefined;
  }
  if (
    injectable.length !== 1 ||
    injectable[0]?.called !== true ||
    injectable[0]?.arguments.length !== 0
  ) {
    addInvalidDecoratorDiagnostic(
      diagnostics,
      "Injectable must appear exactly once as @Injectable().",
      injectable[0]?.span ?? declaration.span,
    );
    return undefined;
  }
  validatePrimaryDecorators(primaryDecorators, declaration, diagnostics);
  const explicitQualifier = explicitQualifierFrom(qualifierDecorators, diagnostics);
  return {
    primary: primaryDecorators.length === 1,
    qualifierDecorators,
    ...(explicitQualifier === undefined ? {} : { explicitQualifier }),
  };
}

function exportedInjectableName(
  declaration: ClassDeclaration,
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  const exportName = declaration.name?.text;
  if (
    declaration.topLevel &&
    !declaration.abstract &&
    exportName !== undefined &&
    declaration.export.kind === "named" &&
    declaration.typeParameters.length === 0
  ) {
    return exportName;
  }
  diagnostics.push(
    diagnostic({
      code: "INVALID_INJECTABLE",
      message: "An Injectable must be a top-level, non-abstract, non-generic direct named export.",
      sourceSpan: declaration.span,
      help: "Export a named concrete class directly from its defining module.",
    }),
  );
  return undefined;
}

interface ImplementationConstructorSelection {
  readonly valid: boolean;
  readonly declaration?: ClassDeclaration["constructors"][number];
}

function implementationConstructorFor(
  declaration: ClassDeclaration,
  diagnostics: CompilerDiagnostic[],
): ImplementationConstructorSelection {
  const implementations = declaration.constructors.filter((candidate) => candidate.implementation);
  const inaccessible = ["private", "protected"].includes(
    implementations[0]?.accessibility ?? "public",
  );
  if (
    declaration.constructors.some((candidate) => !candidate.implementation) ||
    implementations.length > 1 ||
    inaccessible
  ) {
    diagnostics.push(
      diagnostic({
        code: "INVALID_INJECTABLE",
        message:
          "An Injectable must have zero or one public implementation constructor and no overload signatures.",
        sourceSpan: declaration.span,
        help: "Remove constructor overloads and expose one public constructor.",
      }),
    );
    return { valid: false };
  }
  const implementation = implementations.at(0);
  return implementation === undefined
    ? { valid: true }
    : { valid: true, declaration: implementation };
}

interface LinkedClassContracts {
  readonly provided: readonly LinkedSymbol[];
  readonly startHook: boolean;
  readonly closeHook: boolean;
}

function reportUnsupportedType(
  diagnostics: CompilerDiagnostic[],
  symbol: LinkedSymbol,
  span: SourceSpan,
): void {
  diagnostics.push(
    diagnostic({
      code: "UNSUPPORTED_TYPE_DECLARATION",
      message: `${symbol.name} resolves to a declaration kind that Reforce cannot use as a Bean contract.`,
      sourceSpan: span,
      help: "Use a directly linked non-generic class or interface as the Bean contract.",
    }),
  );
}

function validateModuleSyntax(
  sources: readonly ParsedSource[],
  diagnostics: CompilerDiagnostic[],
): void {
  for (const source of sources) {
    for (const declaration of [...source.unit.imports, ...source.unit.exports]) {
      if (declaration.kind !== "unsupported-import" && declaration.kind !== "unsupported-export") {
        continue;
      }
      diagnostics.push(
        diagnostic({
          code: "UNSUPPORTED_MODULE_SYNTAX",
          message: `Module syntax ${declaration.syntaxKind} is not supported by the first production compiler.`,
          sourceSpan: declaration.span,
          help: "Use standard ESM import and export declarations without import attributes.",
        }),
      );
    }
  }
}

function linkedClassContracts(
  source: ParsedSource,
  declaration: ClassDeclaration,
  exportName: string,
  ownSymbol: LinkedSymbol,
  linker: Linker,
  diagnostics: CompilerDiagnostic[],
): LinkedClassContracts {
  const provided: LinkedSymbol[] = [ownSymbol];
  let startHook = false;
  let closeHook = false;
  for (const implementedType of declaration.implements) {
    const linked = linker.resolveType(source, implementedType);
    if (linked === undefined) {
      diagnostics.push(
        diagnostic({
          code: "TYPE_LINK_FAILED",
          message: `Cannot link an implemented interface on ${exportName}.`,
          sourceSpan: implementedType.span,
          help: "Implement a directly linked non-generic named interface.",
        }),
      );
      continue;
    }
    if (linked.symbol.kind === "context") {
      startHook ||= linked.symbol.name === "OnContextStart";
      closeHook ||= linked.symbol.name === "OnContextClose";
      continue;
    }
    if (linked.symbol.kind === "unsupported") {
      reportUnsupportedType(diagnostics, linked.symbol, implementedType.span);
      continue;
    }
    if (linked.symbol.kind !== "interface") {
      continue;
    }
    if (linked.symbol.generic || linked.typeArguments.length > 0) {
      diagnostics.push(
        diagnostic({
          code: "UNSUPPORTED_GENERIC_INTERFACE",
          message: `Interface ${linked.symbol.name} cannot use generic arguments as an Injectable contract.`,
          sourceSpan: implementedType.span,
          help: "Introduce a non-generic application interface for dependency injection.",
        }),
      );
      continue;
    }
    provided.push(...expandProvidedInterface(linked.symbol, linker, diagnostics));
  }
  return { provided, startHook, closeHook };
}

function validateLifecycleMethods(
  declaration: ClassDeclaration,
  exportName: string,
  contracts: LinkedClassContracts,
  diagnostics: CompilerDiagnostic[],
): void {
  const invalidStart =
    contracts.startHook && !validLifecycleMethod(declaration.methods, "onContextStart");
  const invalidClose =
    contracts.closeHook && !validLifecycleMethod(declaration.methods, "onContextClose");
  if (!invalidStart && !invalidClose) {
    return;
  }
  diagnostics.push(
    diagnostic({
      code: "INVALID_LIFECYCLE_DECLARATION",
      message: `Lifecycle methods on ${exportName} must be unique public instance implementations with zero parameters and return void or Promise<void>.`,
      sourceSpan: declaration.span,
      help: "Implement the declared lifecycle interface with one compatible method.",
    }),
  );
}

function constructorParameterDependency(
  source: ParsedSource,
  parameter: ClassDeclaration["constructors"][number]["parameters"][number],
  exportName: string,
  linker: Linker,
  diagnostics: CompilerDiagnostic[],
): PendingDependency | undefined {
  if (
    parameter.optional ||
    parameter.rest ||
    parameter.hasInitializer ||
    parameter.decorators.length > 0
  ) {
    diagnostics.push(
      diagnostic({
        code:
          parameter.decorators.length > 0
            ? "INVALID_DECORATOR_USAGE"
            : "UNSUPPORTED_INJECTION_TYPE",
        message: `Constructor parameter ${parameter.index} on ${exportName} uses an unsupported shape.`,
        sourceSpan: parameter.span,
        help: "Use a required parameter with a named class, interface, qualifier, or Lazy type.",
      }),
    );
    return undefined;
  }
  const linked = linker.resolveType(source, parameter.type);
  if (linked === undefined) {
    diagnostics.push(
      diagnostic({
        code: "UNSUPPORTED_INJECTION_TYPE",
        message: `Constructor parameter ${parameter.index} on ${exportName} is not a supported injection type.`,
        sourceSpan: parameter.span,
        help: "Use a named concrete class, interface, generated qualifier, or Lazy wrapper.",
      }),
    );
    return undefined;
  }
  if (linked.symbol.kind === "context" && linked.symbol.name === "ApplicationContext") {
    diagnostics.push(
      diagnostic({
        code: "UNSUPPORTED_APPLICATION_CONTEXT_INJECTION",
        message: "ApplicationContext cannot be injected into a constructor.",
        sourceSpan: parameter.span,
        help: "Move coordination outside the Bean constructor.",
      }),
    );
    return undefined;
  }
  if (linked.symbol.kind === "unsupported") {
    reportUnsupportedType(diagnostics, linked.symbol, parameter.type.span);
    return undefined;
  }
  if (
    linked.symbol.kind === "interface" &&
    (linked.symbol.generic || linked.typeArguments.length > 0)
  ) {
    diagnostics.push(
      diagnostic({
        code: "UNSUPPORTED_GENERIC_INTERFACE",
        message: `Generic dependency ${linked.symbol.name} is not supported.`,
        sourceSpan: parameter.span,
        help: "Inject a non-generic application interface.",
      }),
    );
    return undefined;
  }
  if (linked.typeArguments.length > 0) {
    diagnostics.push(
      diagnostic({
        code: "UNSUPPORTED_INJECTION_TYPE",
        message: `Generic dependency ${linked.symbol.name} is not supported.`,
        sourceSpan: parameter.span,
        help: "Inject a non-generic concrete class or application interface.",
      }),
    );
    return undefined;
  }
  return { index: parameter.index, linkedType: linked, sourceSpan: parameter.span };
}

function constructorDependencies(
  source: ParsedSource,
  implementation: ClassDeclaration["constructors"][number] | undefined,
  exportName: string,
  linker: Linker,
  diagnostics: CompilerDiagnostic[],
): readonly PendingDependency[] {
  return (implementation?.parameters ?? []).flatMap((parameter) => {
    const dependency = constructorParameterDependency(
      source,
      parameter,
      exportName,
      linker,
      diagnostics,
    );
    return dependency === undefined ? [] : [dependency];
  });
}

function classQualifiers(
  provides: readonly LinkedSymbol[],
  exportName: string,
  selection: ClassDecoratorSelection,
  declaration: ClassDeclaration,
  diagnostics: CompilerDiagnostic[],
): readonly QualifierModel[] {
  const eligibleInterfaces = provides.filter(
    (symbol) =>
      symbol.kind === "interface" &&
      symbol.source !== undefined &&
      symbol.declaration?.kind === "interface" &&
      symbol.declaration.export.kind === "named" &&
      !symbol.generic,
  );
  if (selection.explicitQualifier !== undefined && eligibleInterfaces.length === 0) {
    diagnostics.push(
      diagnostic({
        code: "INVALID_BEAN_QUALIFIER",
        message: `Qualifier on ${exportName} has no eligible application interface.`,
        sourceSpan: selection.qualifierDecorators[0]?.span ?? declaration.span,
        help: "Implement an exported non-generic application interface or remove Qualifier.",
      }),
    );
  }
  const member = selection.explicitQualifier ?? exportName;
  return eligibleInterfaces.map((interfaceSymbol) => ({ interfaceSymbol, member }));
}

function analyzeClass(
  source: ParsedSource,
  declaration: ClassDeclaration,
  linker: Linker,
  diagnostics: CompilerDiagnostic[],
): ProviderDraft | undefined {
  const selection = classDecoratorSelection(source, declaration, linker, diagnostics);
  if (selection === undefined) {
    return undefined;
  }
  const exportName = exportedInjectableName(declaration, diagnostics);
  if (exportName === undefined) {
    return undefined;
  }
  const implementation = implementationConstructorFor(declaration, diagnostics);
  if (!implementation.valid) {
    return undefined;
  }

  const ownSymbol = linker.symbolForDeclaration(source, declaration);
  if (ownSymbol === undefined) {
    diagnostics.push(
      diagnostic({
        code: "TYPE_LINK_FAILED",
        message: `Cannot establish class identity for ${exportName}.`,
        sourceSpan: declaration.span,
        help: "Keep the direct exported class declaration in the application source set.",
      }),
    );
    return undefined;
  }

  const contracts = linkedClassContracts(
    source,
    declaration,
    exportName,
    ownSymbol,
    linker,
    diagnostics,
  );
  validateLifecycleMethods(declaration, exportName, contracts, diagnostics);
  const pendingDependencies = constructorDependencies(
    source,
    implementation.declaration,
    exportName,
    linker,
    diagnostics,
  );
  const provides = dedupeSymbols(contracts.provided);
  const qualifiers = classQualifiers(provides, exportName, selection, declaration, diagnostics);
  const id = `${source.fileId}#${exportName}`;
  return {
    provider: {
      kind: "class",
      id,
      source,
      exportName,
      declarationSource: sourceReference(declaration.span),
      provides,
      primary: selection.primary,
      qualifiers,
      dependencies: [],
      startHook: contracts.startHook,
      closeHook: contracts.closeHook,
    },
    pendingDependencies,
  };
}

function functionOption(
  properties: readonly DefineBeanOptionProperty[],
  kind: "create" | "dispose",
): FunctionDescriptor | undefined {
  const property = properties.find((item) => item.kind === kind);
  if (
    property?.kind !== kind ||
    property.value.kind === "string-literal" ||
    property.value.kind === "boolean-literal"
  ) {
    return undefined;
  }
  if (property.value.kind === "unsupported") {
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
  linker: Linker,
): FactoryProvidedType | undefined {
  let candidate: TypeNode | undefined;
  if (declaration.typeArguments.length === 1) {
    candidate = declaration.typeArguments[0];
  } else if (declaration.typeArguments.length === 0) {
    candidate = create.returnType;
  }
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
  const exportName = declaration.name?.text;
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
  if (create === undefined || create.async || create.parameters.length !== 0) {
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
  if (dispose !== undefined && dispose.parameters.length !== 1) {
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

function analyzeFactory(
  source: ParsedSource,
  declaration: DefineBeanDeclaration,
  linker: Linker,
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
      id: `${source.fileId}#${exportName}`,
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

function collectProviderDrafts(
  sources: readonly ParsedSource[],
  linker: Linker,
  diagnostics: CompilerDiagnostic[],
): readonly ProviderDraft[] {
  const drafts: ProviderDraft[] = [];
  for (const source of sources) {
    if (source.sourceKind.startsWith("d.")) {
      continue;
    }
    for (const declaration of source.unit.classes) {
      const draft = analyzeClass(source, declaration, linker, diagnostics);
      if (draft !== undefined) {
        drafts.push(draft);
      }
    }
    for (const declaration of source.unit.beanFactories) {
      const draft = analyzeFactory(source, declaration, linker, diagnostics);
      if (draft !== undefined) {
        drafts.push(draft);
      }
    }
  }
  return drafts;
}

function validateBeanIdentities(
  drafts: readonly ProviderDraft[],
  diagnostics: CompilerDiagnostic[],
): void {
  const byPortableId = new Map<string, ProviderModel>();
  for (const draft of drafts) {
    const key = draft.provider.id.toLowerCase();
    const collision = byPortableId.get(key);
    if (collision === undefined) {
      byPortableId.set(key, draft.provider);
      continue;
    }
    diagnostics.push(
      diagnostic({
        code: "BEAN_ID_COLLISION",
        message: `Bean identity collides portably: ${draft.provider.id}.`,
        sourceSpan: draft.provider.source.unit.classes.at(0)?.span,
        related: [{ message: collision.id }, { message: draft.provider.id }],
        help: "Rename one direct export or source so Bean IDs differ beyond letter case.",
      }),
    );
  }
}

function indexProviderCandidates(
  drafts: readonly ProviderDraft[],
): ReadonlyMap<string, ProviderModel[]> {
  const candidates = new Map<string, ProviderModel[]>();
  for (const draft of drafts) {
    for (const provided of draft.provider.provides) {
      const existing = candidates.get(provided.key) ?? [];
      existing.push(draft.provider);
      candidates.set(provided.key, existing);
    }
  }
  return candidates;
}

function providerSourceSpan(provider: ProviderModel): SourceSpan {
  return {
    fileId: provider.source.fileId,
    start: provider.declarationSource.start,
    end: provider.declarationSource.end,
  };
}

function providerIdentityRelated(provider: ProviderModel): DiagnosticRelatedInformation {
  return { message: provider.id, sourceSpan: providerSourceSpan(provider) };
}

function qualifierAvailabilityRelated(
  drafts: readonly ProviderDraft[],
  interfaceKey: string,
  member?: string,
): readonly DiagnosticRelatedInformation[] {
  return drafts.flatMap((draft) =>
    draft.provider.qualifiers
      .filter(
        (qualifier) =>
          qualifier.interfaceSymbol.key === interfaceKey &&
          (member === undefined || qualifier.member === member) &&
          validQualifierName(qualifier.member),
      )
      .map((qualifier) => ({
        message: `${qualifier.member} -> ${draft.provider.id} (Primary: ${draft.provider.primary})`,
        sourceSpan: providerSourceSpan(draft.provider),
      })),
  );
}

function indexQualifiers(
  drafts: readonly ProviderDraft[],
  diagnostics: CompilerDiagnostic[],
): ReadonlyMap<string, ProviderModel> {
  const qualifierIndex = new Map<string, ProviderModel>();
  const reportedNamespaceCollisions = new Set<string>();
  for (const draft of drafts) {
    for (const qualifier of draft.provider.qualifiers) {
      if (!validQualifierName(qualifier.member)) {
        diagnostics.push(
          diagnostic({
            code: "INVALID_BEAN_QUALIFIER",
            message: `${qualifier.member} is not a valid non-reserved TypeScript identifier.`,
            help: "Choose a valid identifier for the qualifier member.",
          }),
        );
        continue;
      }
      const key = `${qualifier.interfaceSymbol.key}\0${qualifier.member}`;
      const namespaceMember = qualifierNamespaceMember(qualifier);
      if (namespaceMember !== undefined && !reportedNamespaceCollisions.has(key)) {
        reportedNamespaceCollisions.add(key);
        diagnostics.push(
          diagnostic({
            code: "DUPLICATE_BEAN_QUALIFIER",
            message: `${qualifier.interfaceSymbol.name}.${qualifier.member} already exists in the source namespace.`,
            sourceSpan: namespaceMember.span,
            related: qualifierAvailabilityRelated(
              drafts,
              qualifier.interfaceSymbol.key,
              qualifier.member,
            ),
            help: "Rename the source namespace member or choose another Bean qualifier.",
          }),
        );
      }
      const collision = qualifierIndex.get(key);
      if (collision === undefined) {
        qualifierIndex.set(key, draft.provider);
        continue;
      }
      diagnostics.push(
        diagnostic({
          code: "DUPLICATE_BEAN_QUALIFIER",
          message: `${qualifier.interfaceSymbol.name}.${qualifier.member} is provided by multiple Beans.`,
          related: qualifierAvailabilityRelated(
            drafts,
            qualifier.interfaceSymbol.key,
            qualifier.member,
          ),
          help: "Assign distinct qualifier names within the interface.",
        }),
      );
    }
  }
  return qualifierIndex;
}

function qualifierNamespaceMember(qualifier: QualifierModel): NamespaceExportedMember | undefined {
  const source = qualifier.interfaceSymbol.source;
  if (source === undefined) {
    return undefined;
  }
  return source.unit.namespaces
    .filter(
      (namespace) =>
        namespace.topLevel &&
        namespace.export.kind === "named" &&
        namespace.name.text === qualifier.interfaceSymbol.name,
    )
    .flatMap((namespace) => namespace.exportedMembers)
    .find((member) => member.name.text === qualifier.member);
}

function validatePrimaryCandidates(
  candidates: ReadonlyMap<string, ProviderModel[]>,
  diagnostics: CompilerDiagnostic[],
): void {
  for (const [symbolKey, providers] of candidates) {
    const primary = providers.filter((provider) => provider.primary);
    if (primary.length <= 1) {
      continue;
    }
    diagnostics.push(
      diagnostic({
        code: "MULTIPLE_PRIMARY_BEANS",
        message: `Multiple Primary Beans provide ${symbolKey}.`,
        related: primary
          .toSorted((left, right) => compareUtf16CodeUnits(left.id, right.id))
          .map(providerIdentityRelated),
        help: "Keep at most one Primary provider for each interface.",
      }),
    );
  }
}

function qualifiedDependencyProvider(
  pending: PendingDependency,
  qualifierIndex: ReadonlyMap<string, ProviderModel>,
  drafts: readonly ProviderDraft[],
  diagnostics: CompilerDiagnostic[],
): ProviderModel | undefined {
  const qualifierMember = pending.linkedType.qualifierMember;
  if (qualifierMember === undefined) {
    return undefined;
  }
  const selected = qualifierIndex.get(`${pending.linkedType.symbol.key}\0${qualifierMember}`);
  if (selected !== undefined) {
    return selected;
  }
  diagnostics.push(
    diagnostic({
      code: "UNKNOWN_BEAN_QUALIFIER",
      message: `Unknown qualifier ${pending.linkedType.symbol.name}.${qualifierMember}.`,
      sourceSpan: pending.linkedType.span,
      related: qualifierAvailabilityRelated(drafts, pending.linkedType.symbol.key),
      help: "Use one of the generated qualifier members for this interface.",
    }),
  );
  return undefined;
}

function unqualifiedDependencyProvider(
  pending: PendingDependency,
  candidates: ReadonlyMap<string, ProviderModel[]>,
  diagnostics: CompilerDiagnostic[],
): ProviderModel | undefined {
  const available = candidates.get(pending.linkedType.symbol.key) ?? [];
  if (pending.linkedType.symbol.kind === "class") {
    const source = pending.linkedType.symbol.source;
    const ownId =
      source === undefined ? undefined : `${source.fileId}#${pending.linkedType.symbol.name}`;
    const ownProvider = available.find(
      (provider) => provider.kind === "class" && provider.id === ownId,
    );
    if (ownProvider !== undefined) {
      return ownProvider;
    }
    if (available.length === 0) {
      diagnostics.push(
        diagnostic({
          code: "MISSING_BEAN",
          message: `No Injectable Bean provides ${pending.linkedType.symbol.name}.`,
          sourceSpan: pending.linkedType.span,
          help: "Mark the concrete class Injectable or inject an application interface.",
        }),
      );
      return undefined;
    }
  }
  if (available.length === 1) {
    return available[0];
  }
  if (available.length === 0) {
    diagnostics.push(
      diagnostic({
        code: "MISSING_BEAN",
        message: `No Bean provides ${pending.linkedType.symbol.name}.`,
        sourceSpan: pending.linkedType.span,
        help: "Declare a local Injectable wrapper or defineBean provider in this application.",
      }),
    );
    return undefined;
  }
  const primary = available.filter((provider) => provider.primary);
  if (primary.length === 1) {
    return primary[0];
  }
  if (primary.length === 0) {
    diagnostics.push(
      diagnostic({
        code: "AMBIGUOUS_BEAN",
        message: `Multiple Beans provide ${pending.linkedType.symbol.name}.`,
        sourceSpan: pending.linkedType.span,
        related: available.map(providerIdentityRelated),
        help: "Mark one provider Primary or inject a generated qualifier.",
      }),
    );
  }
  return undefined;
}

function dependencyProvider(
  pending: PendingDependency,
  drafts: readonly ProviderDraft[],
  candidates: ReadonlyMap<string, ProviderModel[]>,
  qualifierIndex: ReadonlyMap<string, ProviderModel>,
  diagnostics: CompilerDiagnostic[],
): ProviderModel | undefined {
  return pending.linkedType.qualifierMember === undefined
    ? unqualifiedDependencyProvider(pending, candidates, diagnostics)
    : qualifiedDependencyProvider(pending, qualifierIndex, drafts, diagnostics);
}

function resolveProviderDependencies(
  drafts: readonly ProviderDraft[],
  candidates: ReadonlyMap<string, ProviderModel[]>,
  qualifierIndex: ReadonlyMap<string, ProviderModel>,
  diagnostics: CompilerDiagnostic[],
): void {
  for (const draft of drafts) {
    for (const pending of draft.pendingDependencies) {
      const selected = dependencyProvider(pending, drafts, candidates, qualifierIndex, diagnostics);
      if (selected === undefined) {
        continue;
      }
      draft.provider.dependencies.push({
        parameterIndex: pending.index,
        targetId: selected.id,
        mode: pending.linkedType.lazy ? "explicit-lazy" : "eager",
        source: sourceReference(pending.sourceSpan),
      });
    }
  }
}

export function analyzeProject(sources: readonly ParsedSource[], linker: Linker): AnalysisResult {
  const diagnostics: CompilerDiagnostic[] = [];
  validateModuleSyntax(sources, diagnostics);
  const drafts = collectProviderDrafts(sources, linker, diagnostics);

  diagnostics.push(...linker.diagnostics);
  validateBeanIdentities(drafts, diagnostics);

  const candidates = indexProviderCandidates(drafts);

  const qualifierIndex = indexQualifiers(drafts, diagnostics);
  validatePrimaryCandidates(candidates, diagnostics);

  resolveProviderDependencies(drafts, candidates, qualifierIndex, diagnostics);

  if (diagnostics.length > 0) {
    return { status: "failure", diagnostics: nonEmptyDiagnostics(diagnostics) };
  }
  const providers = drafts
    .map((draft) => draft.provider)
    .toSorted((left, right) => compareUtf16CodeUnits(left.id, right.id));
  return {
    status: "success",
    providers: Object.freeze(providers),
    plans: createExecutionPlans(providers),
  };
}
