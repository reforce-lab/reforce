import { compareUtf16CodeUnits } from "@reforce/primitives";
import {
  type PendingDependency,
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
  ClassDeclaration,
  ClassMethodDeclaration,
  DecoratorUse,
  TypeNode,
} from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

function isEntityDecorator(decorator: DecoratorUse): decorator is DecoratorUse & {
  readonly callee: Exclude<DecoratorUse["callee"], { readonly kind: "unsupported-expression" }>;
} {
  return decorator.callee.kind !== "unsupported-expression";
}

function contextDecorators(
  source: ParsedSource,
  decorators: readonly DecoratorUse[],
  linker: ProjectLinker,
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
    return method.name.name;
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
    type.name.name !== "Promise" ||
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
      method.parameterCount === 0 &&
      validLifecycleReturn(method),
  );
  if (ambiguousComputedCandidate) {
    return false;
  }
  const candidates = methods.filter((method) => methodName(method) === name);
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  return (
    candidate?.static === false &&
    candidate.accessibility === "public" &&
    candidate.generator === false &&
    candidate.optional === false &&
    candidate.implementation === true &&
    candidate.parameterCount === 0 &&
    validLifecycleReturn(candidate)
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
  linker: ProjectLinker,
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
    // linker.resolveType already records its own diagnostic when it fails; only add
    // TYPE_LINK_FAILED when it didn't, or the same parent type gets reported twice (#108).
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
  linker: ProjectLinker,
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
  const exportName = declaration.name;
  if (
    declaration.topLevel &&
    !declaration.abstract &&
    exportName !== undefined &&
    declaration.export.kind === "named" &&
    !declaration.generic
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

function linkedClassContracts(
  source: ParsedSource,
  declaration: ClassDeclaration,
  exportName: string,
  ownSymbol: LinkedSymbol,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): LinkedClassContracts {
  const provided: LinkedSymbol[] = [ownSymbol];
  let startHook = false;
  let closeHook = false;
  for (const implementedType of declaration.implements) {
    // linker.resolveType already records its own diagnostic when it fails; only add
    // TYPE_LINK_FAILED when it didn't, or the same implemented type gets reported twice (#108).
    const diagnosticCount = linker.diagnostics.length;
    const linked = linker.resolveType(source, implementedType);
    if (linked === undefined) {
      if (linker.diagnostics.length === diagnosticCount) {
        diagnostics.push(
          diagnostic({
            code: "TYPE_LINK_FAILED",
            message: `Cannot link an implemented interface on ${exportName}.`,
            sourceSpan: implementedType.span,
            help: "Implement a directly linked non-generic named interface.",
          }),
        );
      }
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
  linker: ProjectLinker,
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
  // linker.resolveType already records its own diagnostic when it fails; only add
  // UNSUPPORTED_INJECTION_TYPE when it didn't, or one bad parameter type is reported twice (#108).
  const diagnosticCount = linker.diagnostics.length;
  const linked = linker.resolveType(source, parameter.type);
  if (linked === undefined) {
    if (linker.diagnostics.length === diagnosticCount) {
      diagnostics.push(
        diagnostic({
          code: "UNSUPPORTED_INJECTION_TYPE",
          message: `Constructor parameter ${parameter.index} on ${exportName} is not a supported injection type.`,
          sourceSpan: parameter.span,
          help: "Use a named concrete class, interface, generated qualifier, or Lazy wrapper.",
        }),
      );
    }
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
  linker: ProjectLinker,
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

export function analyzeClassProvider(
  source: ParsedSource,
  declaration: ClassDeclaration,
  linker: ProjectLinker,
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
  const id = providerId(source.fileId, exportName);
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
