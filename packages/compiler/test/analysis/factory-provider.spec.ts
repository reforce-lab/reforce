import { describe, expect, test } from "vitest";
import { analyzeFactoryProvider } from "@/analysis/factory-provider";
import type { ProviderDraft } from "@/analysis/model";
import type { CompilerDiagnostic } from "@/api";
import type { LinkedSymbol, LinkedType } from "@/linking/model";
import type { ProjectLinker } from "@/linking/project-linker";
import { emptyStarterLinkage } from "@/linking/starter-linking";
import type {
  DefineBeanDeclaration,
  DefineBeanOptionProperty,
  DefineBeanOptions,
  EntityName,
  ExpressionValue,
  FunctionBodyDescriptor,
  FunctionDescriptor,
  InterfaceDeclaration,
  TypeNode,
} from "@/parser/source-ir";
import { singleFileIr } from "./support/ir";

// Every declaration under test lives in one file, so spans only vary by offset here.
const { fileId, identifier, source, span, stringLiteral, typeReference, voidType } = singleFileIr(
  "src/application.ts",
  "/project/src/application.ts",
);

function booleanLiteral(value: boolean): ExpressionValue {
  return { kind: "boolean-literal", value, span: span() };
}

function contextSymbol(name: string): LinkedSymbol {
  return {
    key: `@reforce/context#${name}`,
    kind: "context",
    name,
    moduleSpecifier: "@reforce/context",
    generic: false,
  };
}

interface InterfaceOptions {
  readonly generic?: boolean;
}

function interfaceSymbol(name: string, options: InterfaceOptions = {}): LinkedSymbol {
  const declaration: InterfaceDeclaration = {
    kind: "interface",
    topLevel: true,
    name,
    export: { kind: "named", exportedName: name, span: span() },
    generic: options.generic ?? false,
    extends: [],
    span: span(),
  };
  return {
    key: `${fileId}#interface:${name}`,
    kind: "interface",
    name,
    moduleSpecifier: fileId,
    source,
    declaration,
    generic: options.generic ?? false,
  };
}

function classSymbol(name: string): LinkedSymbol {
  return {
    key: `${fileId}#class:${name}`,
    kind: "class",
    name,
    moduleSpecifier: fileId,
    generic: false,
  };
}

function unsupportedSymbol(name: string): LinkedSymbol {
  return {
    key: `${fileId}#unsupported:${name}`,
    kind: "unsupported",
    name,
    moduleSpecifier: fileId,
    generic: false,
  };
}

const linkerDiagnostic: CompilerDiagnostic = {
  kind: "compiler",
  code: "TYPE_LINK_FAILED",
  severity: "error",
  message: "The linker already reported this failure.",
  related: [],
};

interface LinkerInput {
  readonly recordsLinkFailure?: boolean;
}

// The real linker resolves modules and external declarations through the filesystem, so analysis
// rules are exercised against an in-memory name table. It decides nothing about Bean selection.
function createLinker(
  symbols: readonly LinkedSymbol[] = [],
  input: LinkerInput = {},
): ProjectLinker {
  const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
  byName.set("defineBean", contextSymbol("defineBean"));
  const diagnostics: CompilerDiagnostic[] = [];
  return {
    diagnostics,
    starterLinkage: emptyStarterLinkage,
    collectWatchInputs: () => ({
      fileDependencies: [],
      contextDependencies: [],
      missingDependencies: [],
    }),
    resolveValueDeclaration: () => undefined,
    resolveEntity(_source, entity) {
      return entity.kind === "identifier" ? byName.get(entity.name) : undefined;
    },
    resolveType(_source, type): LinkedType | undefined {
      if (type.kind !== "reference" || type.name.kind !== "identifier") {
        return undefined;
      }
      const symbol = byName.get(type.name.name);
      if (symbol === undefined) {
        if (input.recordsLinkFailure === true) {
          diagnostics.push(linkerDiagnostic);
        }
        return undefined;
      }
      return {
        symbol,
        typeArguments: type.typeArguments,
        lazy: false,
        current: false,
        span: type.span,
      };
    },
    symbolForDeclaration() {
      return undefined;
    },
  };
}

interface FunctionOptions {
  readonly async?: boolean;
  readonly parameterCount?: number;
  readonly returnType?: TypeNode;
  readonly body?: FunctionBodyDescriptor;
  readonly offset?: number;
}

function inlineFunction(options: FunctionOptions = {}): FunctionDescriptor {
  return {
    kind: "arrow",
    async: options.async ?? false,
    parameterCount: options.parameterCount ?? 0,
    returnType: options.returnType,
    body: options.body ?? { kind: "unsupported", expressionKind: "object", span: span() },
    span: span(options.offset ?? 0),
  };
}

function createOption(
  value: FunctionDescriptor | ExpressionValue = inlineFunction(),
): DefineBeanOptionProperty {
  return { kind: "create", value, span: span() };
}

function disposeOption(
  value: FunctionDescriptor | ExpressionValue = inlineFunction({ parameterCount: 1 }),
): DefineBeanOptionProperty {
  return { kind: "dispose", value, span: span() };
}

function primaryOption(value: ExpressionValue): DefineBeanOptionProperty {
  return { kind: "primary", value, span: span() };
}

function qualifierOption(value: ExpressionValue): DefineBeanOptionProperty {
  return { kind: "qualifier", value, span: span() };
}

interface BeanOptions {
  readonly name?: string;
  readonly declarationKind?: DefineBeanDeclaration["declarationKind"];
  readonly topLevel?: boolean;
  readonly export?: DefineBeanDeclaration["export"];
  readonly callee?: EntityName;
  readonly typeArguments?: readonly TypeNode[];
  readonly properties?: readonly DefineBeanOptionProperty[];
  readonly options?: DefineBeanOptions;
}

function beanDeclaration(options: BeanOptions = {}): DefineBeanDeclaration {
  const name = options.name ?? "resource";
  return {
    kind: "define-bean",
    topLevel: options.topLevel ?? true,
    declarationKind: options.declarationKind ?? "const",
    name,
    export: options.export ?? { kind: "named", exportedName: name, span: span() },
    callee: options.callee ?? identifier("defineBean"),
    typeArguments: options.typeArguments ?? [],
    options: options.options ?? {
      kind: "object",
      properties: options.properties ?? [createOption()],
      span: span(),
    },
    span: span(),
  };
}

interface AnalysisOutcome {
  readonly draft: ProviderDraft | undefined;
  readonly codes: readonly string[];
  readonly diagnostics: readonly CompilerDiagnostic[];
}

function analyze(declaration: DefineBeanDeclaration, linker = createLinker()): AnalysisOutcome {
  const diagnostics: CompilerDiagnostic[] = [];
  const draft = analyzeFactoryProvider(source, declaration, linker, diagnostics);
  return { draft, codes: diagnostics.map((item) => item.code), diagnostics };
}

const portLinker = createLinker([interfaceSymbol("Port")]);

describe("factory provider analysis", () => {
  test("ignores a call whose callee does not resolve to defineBean", () => {
    const declaration = beanDeclaration({ callee: identifier("createBean") });

    const outcome = analyze(declaration);

    expect(outcome.draft).toBeUndefined();
    expect(outcome.codes).toEqual([]);
  });

  test("rejects a defineBean bound to let", () => {
    const declaration = beanDeclaration({ declarationKind: "let" });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("rejects a defineBean that is not a top-level declaration", () => {
    const declaration = beanDeclaration({ topLevel: false });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("rejects a defineBean that is not a direct named export", () => {
    const declaration = beanDeclaration({ export: { kind: "none" } });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("rejects defineBean options that are not an inline object", () => {
    const declaration = beanDeclaration({
      options: { kind: "unsupported", expressionKind: "identifier", span: span() },
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("rejects more than one explicit provided type argument", () => {
    const declaration = beanDeclaration({
      typeArguments: [typeReference("Port"), typeReference("Port")],
    });

    const outcome = analyze(declaration, portLinker);

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("rejects duplicate defineBean options", () => {
    const declaration = beanDeclaration({ properties: [createOption(), createOption()] });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("rejects an unsupported defineBean option property", () => {
    const declaration = beanDeclaration({
      properties: [
        createOption(),
        { kind: "unsupported-property", propertyKind: "spread", span: span() },
      ],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("rejects a missing create option", () => {
    const declaration = beanDeclaration({ properties: [] });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("rejects a create option that is not an inline function", () => {
    const declaration = beanDeclaration({ properties: [createOption(stringLiteral("resource"))] });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("rejects an async create", () => {
    const declaration = beanDeclaration({
      properties: [createOption(inlineFunction({ async: true }))],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("rejects a create that declares parameters", () => {
    const declaration = beanDeclaration({
      properties: [createOption(inlineFunction({ parameterCount: 1 }))],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("rejects a dispose option that is not an inline function", () => {
    const declaration = beanDeclaration({
      properties: [createOption(), disposeOption(stringLiteral("close"))],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("rejects a dispose that does not accept exactly one parameter", () => {
    const declaration = beanDeclaration({
      properties: [createOption(), disposeOption(inlineFunction({ parameterCount: 0, offset: 7 }))],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
    expect(outcome.diagnostics[0]?.sourceSpan).toEqual(span(7));
  });

  test("rejects a non-boolean primary literal", () => {
    const declaration = beanDeclaration({
      typeArguments: [typeReference("Port")],
      properties: [createOption(), primaryOption(stringLiteral("yes"))],
    });

    const outcome = analyze(declaration, portLinker);

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("rejects a non-string qualifier literal", () => {
    const declaration = beanDeclaration({
      typeArguments: [typeReference("Port")],
      properties: [createOption(), qualifierOption(booleanLiteral(true))],
    });

    const outcome = analyze(declaration, portLinker);

    expect(outcome.codes).toEqual(["INVALID_BEAN_QUALIFIER"]);
  });

  test("rejects a qualifier on a concrete provided type", () => {
    const declaration = beanDeclaration({
      typeArguments: [typeReference("Repository")],
      properties: [createOption(), qualifierOption(stringLiteral("fast"))],
    });

    const outcome = analyze(declaration, createLinker([classSymbol("Repository")]));

    expect(outcome.codes).toEqual(["INVALID_BEAN_QUALIFIER"]);
    expect(outcome.diagnostics[0]?.message).toBe(
      "resource cannot qualify a concrete or external provided type.",
    );
  });

  test("rejects a provided type that cannot be resolved", () => {
    const declaration = beanDeclaration({ typeArguments: [typeReference("Missing")] });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("reports an unresolvable provided type only once when the linker already recorded it", () => {
    const declaration = beanDeclaration({ typeArguments: [typeReference("Missing")] });

    const outcome = analyze(declaration, createLinker([], { recordsLinkFailure: true }));

    expect(outcome.codes).toEqual([]);
  });

  test("rejects a generic provided type", () => {
    const declaration = beanDeclaration({ typeArguments: [typeReference("Port")] });

    const outcome = analyze(
      declaration,
      createLinker([interfaceSymbol("Port", { generic: true })]),
    );

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("rejects a provided type used with type arguments", () => {
    const declaration = beanDeclaration({ typeArguments: [typeReference("Port", [voidType])] });

    const outcome = analyze(declaration, portLinker);

    expect(outcome.codes).toEqual(["INVALID_DEFINE_BEAN"]);
  });

  test("reports a provided type that resolves to an unsupported declaration", () => {
    const declaration = beanDeclaration({ typeArguments: [typeReference("Alias")] });

    const outcome = analyze(declaration, createLinker([unsupportedSymbol("Alias")]));

    expect(outcome.codes).toEqual(["UNSUPPORTED_TYPE_DECLARATION"]);
  });

  test("infers the provided type from the create return type", () => {
    const declaration = beanDeclaration({
      properties: [createOption(inlineFunction({ returnType: typeReference("Port") }))],
    });

    const outcome = analyze(declaration, portLinker);

    expect(outcome.draft?.provider.provides.map((symbol) => symbol.name)).toEqual(["Port"]);
  });

  test("infers the provided type from a direct new expression", () => {
    const declaration = beanDeclaration({
      properties: [
        createOption(
          inlineFunction({
            body: { kind: "direct-new", callee: identifier("Repository"), span: span() },
          }),
        ),
      ],
    });

    const outcome = analyze(declaration, createLinker([classSymbol("Repository")]));

    expect(outcome.draft?.provider.provides.map((symbol) => symbol.name)).toEqual(["Repository"]);
  });

  test("prefers the explicit type argument over the create return type", () => {
    const declaration = beanDeclaration({
      typeArguments: [typeReference("Port")],
      properties: [createOption(inlineFunction({ returnType: typeReference("Repository") }))],
    });

    const outcome = analyze(
      declaration,
      createLinker([interfaceSymbol("Port"), classSymbol("Repository")]),
    );

    expect(outcome.draft?.provider.provides.map((symbol) => symbol.name)).toEqual(["Port"]);
  });

  test("marks the factory disposable when dispose is present", () => {
    const declaration = beanDeclaration({
      typeArguments: [typeReference("Port")],
      properties: [createOption(), disposeOption()],
    });

    const outcome = analyze(declaration, portLinker);

    expect(outcome.draft?.provider).toMatchObject({ kind: "factory", dispose: true });
  });

  test("defaults the qualifier member to the export name", () => {
    const declaration = beanDeclaration({ typeArguments: [typeReference("Port")] });

    const outcome = analyze(declaration, portLinker);

    expect(outcome.draft?.provider.qualifiers.map((qualifier) => qualifier.member)).toEqual([
      "resource",
    ]);
  });

  test("uses the explicit qualifier string as the qualifier member", () => {
    const declaration = beanDeclaration({
      typeArguments: [typeReference("Port")],
      properties: [createOption(), qualifierOption(stringLiteral("fast"))],
    });

    const outcome = analyze(declaration, portLinker);

    expect(outcome.draft?.provider.qualifiers.map((qualifier) => qualifier.member)).toEqual([
      "fast",
    ]);
  });

  test("marks the factory Primary for a primary option", () => {
    const declaration = beanDeclaration({
      typeArguments: [typeReference("Port")],
      properties: [createOption(), primaryOption(booleanLiteral(true))],
    });

    const outcome = analyze(declaration, portLinker);

    expect(outcome.draft?.provider.primary).toBe(true);
  });

  test("produces no pending dependencies", () => {
    const declaration = beanDeclaration({ typeArguments: [typeReference("Port")] });

    const outcome = analyze(declaration, portLinker);

    expect(outcome.draft?.pendingDependencies).toEqual([]);
  });
});
