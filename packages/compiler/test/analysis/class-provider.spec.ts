import { describe, expect, test } from "vitest";
import { analyzeClassProvider } from "@/analysis/class-provider";
import type { ProviderDraft } from "@/analysis/model";
import type { CompilerDiagnostic } from "@/api";
import type { LinkedSymbol, LinkedType } from "@/linking/model";
import type { ProjectLinker } from "@/linking/project-linker";
import { emptyStarterLinkage } from "@/linking/starter-linking";
import type {
  ClassDeclaration,
  ClassMethodDeclaration,
  ConstructorDeclaration,
  ConstructorParameter,
  DeclarationExport,
  DecoratorUse,
  ExpressionValue,
  InterfaceDeclaration,
  TypeNode,
} from "@/parser/source-ir";
import { singleFileIr } from "./support/ir";

// Every declaration under test lives in one file, so spans only vary by offset here.
const { fileId, identifier, source, span, stringLiteral, typeReference, voidType } = singleFileIr(
  "src/application.ts",
  "/project/src/application.ts",
);

interface DecoratorOptions {
  readonly arguments?: readonly ExpressionValue[];
  readonly called?: boolean;
}

function decorator(name: string, options: DecoratorOptions = {}): DecoratorUse {
  return {
    kind: "decorator",
    callee: identifier(name),
    called: options.called ?? true,
    arguments: options.arguments ?? [],
    span: span(),
  };
}

const contextNames = [
  "Injectable",
  "Primary",
  "Qualifier",
  "OnContextStart",
  "OnContextClose",
  "ApplicationContext",
];

function coreSymbol(name: string): LinkedSymbol {
  return {
    key: `@reforce/core#${name}`,
    kind: "core",
    name,
    moduleSpecifier: "@reforce/core",
    generic: false,
  };
}

interface InterfaceOptions {
  readonly extends?: readonly TypeNode[];
  readonly generic?: boolean;
  readonly export?: DeclarationExport;
}

function interfaceSymbol(name: string, options: InterfaceOptions = {}): LinkedSymbol {
  const declaration: InterfaceDeclaration = {
    kind: "interface",
    topLevel: true,
    name,
    export: options.export ?? { kind: "named", exportedName: name, span: span() },
    generic: options.generic ?? false,
    extends: options.extends ?? [],
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

function externalInterfaceSymbol(name: string): LinkedSymbol {
  return {
    key: `vendor#interface:${name}`,
    kind: "interface",
    name,
    moduleSpecifier: "vendor",
    generic: false,
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
  readonly symbols?: readonly LinkedSymbol[];
  readonly linksOwnSymbol?: boolean;
  readonly recordsLinkFailure?: boolean;
}

// The real linker resolves modules and external declarations through the filesystem, so analysis
// rules are exercised against an in-memory name table. It decides nothing about Bean selection.
function createLinker(input: LinkerInput = {}): ProjectLinker {
  const byName = new Map((input.symbols ?? []).map((symbol) => [symbol.name, symbol]));
  for (const name of contextNames) {
    byName.set(name, coreSymbol(name));
  }
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
    symbolForDeclaration(_source, declaration) {
      const name = declaration.name;
      if (input.linksOwnSymbol === false || name === undefined) {
        return undefined;
      }
      return {
        key: `${fileId}#${declaration.kind}:${name}`,
        kind: declaration.kind,
        name,
        moduleSpecifier: fileId,
        source,
        declaration,
        generic: declaration.generic,
      };
    },
  };
}

interface ConstructorOptions {
  readonly accessibility?: ConstructorDeclaration["accessibility"];
  readonly implementation?: boolean;
  readonly parameters?: readonly ConstructorParameter[];
}

function constructorDeclaration(options: ConstructorOptions = {}): ConstructorDeclaration {
  return {
    kind: "constructor",
    accessibility: options.accessibility ?? "public",
    implementation: options.implementation ?? true,
    parameters: options.parameters ?? [],
    span: span(),
  };
}

interface ParameterOptions {
  readonly optional?: boolean;
  readonly rest?: boolean;
  readonly hasInitializer?: boolean;
  readonly decorators?: readonly DecoratorUse[];
}

function parameter(
  index: number,
  type: TypeNode,
  options: ParameterOptions = {},
): ConstructorParameter {
  return {
    kind: "constructor-parameter",
    index,
    type,
    optional: options.optional ?? false,
    rest: options.rest ?? false,
    hasInitializer: options.hasInitializer ?? false,
    decorators: options.decorators ?? [],
    span: span(index),
  };
}

interface MethodOptions {
  readonly static?: boolean;
  readonly accessibility?: ClassMethodDeclaration["accessibility"];
  readonly async?: boolean;
  readonly generator?: boolean;
  readonly optional?: boolean;
  readonly implementation?: boolean;
  readonly parameterCount?: number;
  readonly returnType?: TypeNode;
}

function methodBody(
  name: ClassMethodDeclaration["name"],
  options: MethodOptions,
): ClassMethodDeclaration {
  return {
    kind: "method",
    name,
    static: options.static ?? false,
    accessibility: options.accessibility ?? "public",
    async: options.async ?? false,
    generator: options.generator ?? false,
    optional: options.optional ?? false,
    implementation: options.implementation ?? true,
    parameters: Array.from({ length: options.parameterCount ?? 0 }, (_, index) => ({
      kind: "method-parameter" as const,
      index,
      optional: false,
      rest: false,
      hasInitializer: false,
      span: span(),
    })),
    returnType: options.returnType ?? voidType,
    decorators: [],
    span: span(),
  };
}

function method(name: string, options: MethodOptions = {}): ClassMethodDeclaration {
  return methodBody({ kind: "identifier", name }, options);
}

function computedMethod(options: MethodOptions = {}): ClassMethodDeclaration {
  return methodBody({ kind: "computed", span: span() }, options);
}

const startHookMethod = method("onContextStart");

interface ClassOptions {
  readonly name?: string;
  readonly decorators?: readonly DecoratorUse[];
  readonly implements?: readonly TypeNode[];
  readonly constructors?: readonly ConstructorDeclaration[];
  readonly methods?: readonly ClassMethodDeclaration[];
  readonly abstract?: boolean;
  readonly generic?: boolean;
  readonly topLevel?: boolean;
  readonly export?: DeclarationExport;
}

function classDeclaration(options: ClassOptions = {}): ClassDeclaration {
  const name = options.name ?? "Service";
  return {
    kind: "class",
    topLevel: options.topLevel ?? true,
    abstract: options.abstract ?? false,
    name,
    export: options.export ?? { kind: "named", exportedName: name, span: span() },
    generic: options.generic ?? false,
    decorators: options.decorators ?? [decorator("Injectable")],
    fields: [],
    implements: options.implements ?? [],
    constructors: options.constructors ?? [],
    methods: options.methods ?? [],
    span: span(),
  };
}

interface AnalysisOutcome {
  readonly draft: ProviderDraft | undefined;
  readonly codes: readonly string[];
  readonly diagnostics: readonly CompilerDiagnostic[];
}

function analyze(declaration: ClassDeclaration, linker = createLinker()): AnalysisOutcome {
  const diagnostics: CompilerDiagnostic[] = [];
  const draft = analyzeClassProvider(source, declaration, linker, diagnostics);
  return { draft, codes: diagnostics.map((item) => item.code), diagnostics };
}

describe("class provider analysis", () => {
  test("ignores a class whose decorator does not resolve to a Reforce entity", () => {
    const declaration = classDeclaration({ decorators: [decorator("Component")] });

    const outcome = analyze(declaration);

    expect(outcome.draft).toBeUndefined();
    expect(outcome.codes).toEqual([]);
  });

  test("rejects Primary on a class that is not a Bean", () => {
    const declaration = classDeclaration({ decorators: [decorator("Primary")] });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DECORATOR_USAGE"]);
  });

  test("rejects Qualifier on a class that is not a Bean", () => {
    const declaration = classDeclaration({
      decorators: [decorator("Qualifier", { arguments: [stringLiteral("fast")] })],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DECORATOR_USAGE"]);
  });

  test("rejects a repeated Injectable decorator", () => {
    const declaration = classDeclaration({
      decorators: [decorator("Injectable"), decorator("Injectable")],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DECORATOR_USAGE"]);
  });

  test("rejects an Injectable decorator that is not called", () => {
    const declaration = classDeclaration({
      decorators: [decorator("Injectable", { called: false })],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DECORATOR_USAGE"]);
  });

  test("rejects an Injectable decorator with arguments", () => {
    const declaration = classDeclaration({
      decorators: [decorator("Injectable", { arguments: [stringLiteral("fast")] })],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DECORATOR_USAGE"]);
  });

  test("rejects a repeated Primary decorator", () => {
    const declaration = classDeclaration({
      decorators: [decorator("Injectable"), decorator("Primary"), decorator("Primary")],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DECORATOR_USAGE"]);
  });

  test("rejects a Primary decorator with arguments", () => {
    const declaration = classDeclaration({
      decorators: [
        decorator("Injectable"),
        decorator("Primary", { arguments: [stringLiteral("fast")] }),
      ],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DECORATOR_USAGE"]);
  });

  test("rejects a Qualifier without a single string literal argument", () => {
    const declaration = classDeclaration({
      decorators: [decorator("Injectable"), decorator("Qualifier")],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_DECORATOR_USAGE"]);
  });

  test("rejects an abstract Injectable", () => {
    const declaration = classDeclaration({ abstract: true });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_INJECTABLE"]);
  });

  test("rejects a generic Injectable", () => {
    const declaration = classDeclaration({ generic: true });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_INJECTABLE"]);
  });

  test("rejects an Injectable that is not a direct named export", () => {
    const declaration = classDeclaration({ export: { kind: "none" } });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_INJECTABLE"]);
  });

  test("rejects an Injectable that is not top-level", () => {
    const declaration = classDeclaration({ topLevel: false });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_INJECTABLE"]);
  });

  test("rejects constructor overload signatures", () => {
    const declaration = classDeclaration({
      constructors: [constructorDeclaration({ implementation: false }), constructorDeclaration()],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_INJECTABLE"]);
  });

  test("rejects a private constructor", () => {
    const declaration = classDeclaration({
      constructors: [constructorDeclaration({ accessibility: "private" })],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_INJECTABLE"]);
  });

  test("rejects two implementation constructors", () => {
    const declaration = classDeclaration({
      constructors: [constructorDeclaration(), constructorDeclaration()],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_INJECTABLE"]);
  });

  test("reports an unresolvable class identity", () => {
    const declaration = classDeclaration();

    const outcome = analyze(declaration, createLinker({ linksOwnSymbol: false }));

    expect(outcome.codes).toEqual(["TYPE_LINK_FAILED"]);
  });

  test("reports an unlinkable implemented interface", () => {
    const declaration = classDeclaration({ implements: [typeReference("Port")] });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["TYPE_LINK_FAILED"]);
  });

  test("reports an unlinkable implemented interface only once when the linker already recorded it", () => {
    const declaration = classDeclaration({ implements: [typeReference("Port")] });

    const outcome = analyze(declaration, createLinker({ recordsLinkFailure: true }));

    expect(outcome.codes).toEqual([]);
  });

  test("reports an implemented type that resolves to an unsupported declaration", () => {
    const declaration = classDeclaration({ implements: [typeReference("Alias")] });

    const outcome = analyze(declaration, createLinker({ symbols: [unsupportedSymbol("Alias")] }));

    expect(outcome.codes).toEqual(["UNSUPPORTED_TYPE_DECLARATION"]);
  });

  test("rejects a generic implemented interface", () => {
    const declaration = classDeclaration({ implements: [typeReference("Port")] });

    const outcome = analyze(
      declaration,
      createLinker({ symbols: [interfaceSymbol("Port", { generic: true })] }),
    );

    expect(outcome.codes).toEqual(["UNSUPPORTED_GENERIC_INTERFACE"]);
  });

  test("ignores an implemented type that resolves to a class", () => {
    const declaration = classDeclaration({ implements: [typeReference("Base")] });

    const outcome = analyze(declaration, createLinker({ symbols: [classSymbol("Base")] }));

    expect(outcome.codes).toEqual([]);
  });

  test("reports an unlinkable parent interface", () => {
    const declaration = classDeclaration({ implements: [typeReference("Port")] });
    const linker = createLinker({
      symbols: [interfaceSymbol("Port", { extends: [typeReference("Missing")] })],
    });

    const outcome = analyze(declaration, linker);

    expect(outcome.codes).toEqual(["TYPE_LINK_FAILED"]);
  });

  test("reports an unlinkable parent interface only once when the linker already recorded it", () => {
    const declaration = classDeclaration({ implements: [typeReference("Port")] });
    const linker = createLinker({
      symbols: [interfaceSymbol("Port", { extends: [typeReference("Missing")] })],
      recordsLinkFailure: true,
    });

    const outcome = analyze(declaration, linker);

    expect(outcome.codes).toEqual([]);
  });

  test("rejects a generic parent interface", () => {
    const declaration = classDeclaration({ implements: [typeReference("Port")] });
    const linker = createLinker({
      symbols: [
        interfaceSymbol("Port", { extends: [typeReference("Base")] }),
        interfaceSymbol("Base", { generic: true }),
      ],
    });

    const outcome = analyze(declaration, linker);

    expect(outcome.codes).toEqual(["UNSUPPORTED_GENERIC_INTERFACE"]);
  });

  test("rejects a parent that is not an application interface", () => {
    const declaration = classDeclaration({ implements: [typeReference("Port")] });
    const linker = createLinker({
      symbols: [
        interfaceSymbol("Port", { extends: [typeReference("Vendor")] }),
        externalInterfaceSymbol("Vendor"),
      ],
    });

    const outcome = analyze(declaration, linker);

    expect(outcome.codes).toEqual(["TYPE_LINK_FAILED"]);
  });

  test("stops expanding a cyclic interface hierarchy", () => {
    const declaration = classDeclaration({ implements: [typeReference("Port")] });
    const linker = createLinker({
      symbols: [
        interfaceSymbol("Port", { extends: [typeReference("Base")] }),
        interfaceSymbol("Base", { extends: [typeReference("Port")] }),
      ],
    });

    const outcome = analyze(declaration, linker);

    expect(outcome.draft?.provider.provides.map((symbol) => symbol.name)).toEqual([
      "Service",
      "Base",
      "Port",
    ]);
  });

  test("expands the parents of an implemented interface", () => {
    const declaration = classDeclaration({ implements: [typeReference("Port")] });
    const linker = createLinker({
      symbols: [
        interfaceSymbol("Port", { extends: [typeReference("Base")] }),
        interfaceSymbol("Base"),
      ],
    });

    const outcome = analyze(declaration, linker);

    expect(outcome.draft?.provider.provides.map((symbol) => symbol.name)).toContain("Base");
  });

  test("orders and deduplicates provided symbols by key", () => {
    const declaration = classDeclaration({
      implements: [typeReference("Port"), typeReference("Port"), typeReference("Alpha")],
    });
    const linker = createLinker({
      symbols: [interfaceSymbol("Port"), interfaceSymbol("Alpha")],
    });

    const outcome = analyze(declaration, linker);

    expect(outcome.draft?.provider.provides.map((symbol) => symbol.key)).toEqual([
      `${fileId}#class:Service`,
      `${fileId}#interface:Alpha`,
      `${fileId}#interface:Port`,
    ]);
  });

  test("reports a lifecycle interface without a matching method", () => {
    const declaration = classDeclaration({ implements: [typeReference("OnContextStart")] });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_LIFECYCLE_DECLARATION"]);
  });

  test("rejects a static lifecycle method", () => {
    const declaration = classDeclaration({
      implements: [typeReference("OnContextStart")],
      methods: [method("onContextStart", { static: true })],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_LIFECYCLE_DECLARATION"]);
  });

  test("rejects a non-public lifecycle method", () => {
    const declaration = classDeclaration({
      implements: [typeReference("OnContextStart")],
      methods: [method("onContextStart", { accessibility: "protected" })],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_LIFECYCLE_DECLARATION"]);
  });

  test("rejects a lifecycle method with parameters", () => {
    const declaration = classDeclaration({
      implements: [typeReference("OnContextStart")],
      methods: [method("onContextStart", { parameterCount: 1 })],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_LIFECYCLE_DECLARATION"]);
  });

  test("rejects an optional lifecycle method", () => {
    const declaration = classDeclaration({
      implements: [typeReference("OnContextStart")],
      methods: [method("onContextStart", { optional: true })],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_LIFECYCLE_DECLARATION"]);
  });

  test("rejects a lifecycle method declared without an implementation", () => {
    const declaration = classDeclaration({
      implements: [typeReference("OnContextStart")],
      methods: [method("onContextStart", { implementation: false })],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_LIFECYCLE_DECLARATION"]);
  });

  test("rejects an async lifecycle method that does not return Promise<void>", () => {
    const declaration = classDeclaration({
      implements: [typeReference("OnContextStart")],
      methods: [method("onContextStart", { async: true, returnType: voidType })],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_LIFECYCLE_DECLARATION"]);
  });

  test("rejects two methods sharing the lifecycle name", () => {
    const declaration = classDeclaration({
      implements: [typeReference("OnContextStart")],
      methods: [startHookMethod, startHookMethod],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_LIFECYCLE_DECLARATION"]);
  });

  test("rejects a computed method that could be the lifecycle hook", () => {
    const declaration = classDeclaration({
      implements: [typeReference("OnContextStart")],
      methods: [startHookMethod, computedMethod()],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_LIFECYCLE_DECLARATION"]);
  });

  test("detects the OnContextStart hook", () => {
    const declaration = classDeclaration({
      implements: [typeReference("OnContextStart")],
      methods: [startHookMethod],
    });

    const outcome = analyze(declaration);

    expect(outcome.draft?.provider).toMatchObject({ kind: "class", startHook: true });
  });

  test("detects the OnContextClose hook", () => {
    const declaration = classDeclaration({
      implements: [typeReference("OnContextClose")],
      methods: [method("onContextClose")],
    });

    const outcome = analyze(declaration);

    expect(outcome.draft?.provider).toMatchObject({ kind: "class", closeHook: true });
  });

  test("accepts an async lifecycle method returning Promise<void>", () => {
    const declaration = classDeclaration({
      implements: [typeReference("OnContextStart")],
      methods: [
        method("onContextStart", { async: true, returnType: typeReference("Promise", [voidType]) }),
      ],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual([]);
  });

  test("rejects a decorated constructor parameter", () => {
    const declaration = classDeclaration({
      constructors: [
        constructorDeclaration({
          parameters: [parameter(0, typeReference("Port"), { decorators: [decorator("Inject")] })],
        }),
      ],
    });

    const outcome = analyze(declaration, createLinker({ symbols: [interfaceSymbol("Port")] }));

    expect(outcome.codes).toEqual(["INVALID_DECORATOR_USAGE"]);
  });

  test("rejects an optional constructor parameter", () => {
    const declaration = classDeclaration({
      constructors: [
        constructorDeclaration({
          parameters: [parameter(0, typeReference("Port"), { optional: true })],
        }),
      ],
    });

    const outcome = analyze(declaration, createLinker({ symbols: [interfaceSymbol("Port")] }));

    expect(outcome.codes).toEqual(["UNSUPPORTED_INJECTION_TYPE"]);
  });

  test("rejects a rest constructor parameter", () => {
    const declaration = classDeclaration({
      constructors: [
        constructorDeclaration({
          parameters: [parameter(0, typeReference("Port"), { rest: true })],
        }),
      ],
    });

    const outcome = analyze(declaration, createLinker({ symbols: [interfaceSymbol("Port")] }));

    expect(outcome.codes).toEqual(["UNSUPPORTED_INJECTION_TYPE"]);
  });

  test("rejects a constructor parameter with an initializer", () => {
    const declaration = classDeclaration({
      constructors: [
        constructorDeclaration({
          parameters: [parameter(0, typeReference("Port"), { hasInitializer: true })],
        }),
      ],
    });

    const outcome = analyze(declaration, createLinker({ symbols: [interfaceSymbol("Port")] }));

    expect(outcome.codes).toEqual(["UNSUPPORTED_INJECTION_TYPE"]);
  });

  test("rejects an unlinkable constructor parameter type", () => {
    const declaration = classDeclaration({
      constructors: [constructorDeclaration({ parameters: [parameter(0, typeReference("Port"))] })],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["UNSUPPORTED_INJECTION_TYPE"]);
  });

  test("reports an unlinkable constructor parameter type only once when the linker already recorded it", () => {
    const declaration = classDeclaration({
      constructors: [constructorDeclaration({ parameters: [parameter(0, typeReference("Port"))] })],
    });

    const outcome = analyze(declaration, createLinker({ recordsLinkFailure: true }));

    expect(outcome.codes).toEqual([]);
  });

  test("rejects ApplicationContext injection", () => {
    const declaration = classDeclaration({
      constructors: [
        constructorDeclaration({
          parameters: [parameter(0, typeReference("ApplicationContext"))],
        }),
      ],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["UNSUPPORTED_APPLICATION_CONTEXT_INJECTION"]);
  });

  test("rejects a constructor parameter whose type is an unsupported declaration", () => {
    const declaration = classDeclaration({
      constructors: [
        constructorDeclaration({ parameters: [parameter(0, typeReference("Alias"))] }),
      ],
    });

    const outcome = analyze(declaration, createLinker({ symbols: [unsupportedSymbol("Alias")] }));

    expect(outcome.codes).toEqual(["UNSUPPORTED_TYPE_DECLARATION"]);
  });

  test("rejects a generic interface dependency", () => {
    const declaration = classDeclaration({
      constructors: [constructorDeclaration({ parameters: [parameter(0, typeReference("Port"))] })],
    });

    const outcome = analyze(
      declaration,
      createLinker({ symbols: [interfaceSymbol("Port", { generic: true })] }),
    );

    expect(outcome.codes).toEqual(["UNSUPPORTED_GENERIC_INTERFACE"]);
  });

  test("rejects a class dependency that carries type arguments", () => {
    const declaration = classDeclaration({
      constructors: [
        constructorDeclaration({
          parameters: [parameter(0, typeReference("Repository", [voidType]))],
        }),
      ],
    });

    const outcome = analyze(declaration, createLinker({ symbols: [classSymbol("Repository")] }));

    expect(outcome.codes).toEqual(["UNSUPPORTED_INJECTION_TYPE"]);
  });

  test("collects each constructor parameter as a pending dependency with its index", () => {
    const declaration = classDeclaration({
      constructors: [
        constructorDeclaration({
          parameters: [parameter(0, typeReference("Port")), parameter(1, typeReference("Repo"))],
        }),
      ],
    });
    const linker = createLinker({ symbols: [interfaceSymbol("Port"), classSymbol("Repo")] });

    const outcome = analyze(declaration, linker);

    expect(
      outcome.draft?.pendingDependencies.map((dependency) => [
        dependency.index,
        dependency.linkedType.symbol.name,
      ]),
    ).toEqual([
      [0, "Port"],
      [1, "Repo"],
    ]);
  });

  test("reports a Qualifier that has no eligible application interface", () => {
    const declaration = classDeclaration({
      decorators: [
        decorator("Injectable"),
        decorator("Qualifier", { arguments: [stringLiteral("fast")] }),
      ],
    });

    const outcome = analyze(declaration);

    expect(outcome.codes).toEqual(["INVALID_BEAN_QUALIFIER"]);
  });

  test("still produces the provider when a Qualifier has no eligible application interface", () => {
    const declaration = classDeclaration({
      decorators: [
        decorator("Injectable"),
        decorator("Qualifier", { arguments: [stringLiteral("fast")] }),
      ],
    });

    const outcome = analyze(declaration);

    expect(outcome.draft?.provider.id).toBe(`${fileId}#Service`);
  });

  test("defaults the qualifier member to the export name", () => {
    const declaration = classDeclaration({ implements: [typeReference("Port")] });

    const outcome = analyze(declaration, createLinker({ symbols: [interfaceSymbol("Port")] }));

    expect(outcome.draft?.provider.qualifiers.map((qualifier) => qualifier.member)).toEqual([
      "Service",
    ]);
  });

  test("uses the explicit Qualifier argument as the qualifier member", () => {
    const declaration = classDeclaration({
      decorators: [
        decorator("Injectable"),
        decorator("Qualifier", { arguments: [stringLiteral("fast")] }),
      ],
      implements: [typeReference("Port")],
    });

    const outcome = analyze(declaration, createLinker({ symbols: [interfaceSymbol("Port")] }));

    expect(outcome.draft?.provider.qualifiers.map((qualifier) => qualifier.member)).toEqual([
      "fast",
    ]);
  });

  test("marks the provider Primary for a Primary decorator", () => {
    const declaration = classDeclaration({
      decorators: [decorator("Injectable"), decorator("Primary")],
    });

    const outcome = analyze(declaration);

    expect(outcome.draft?.provider.primary).toBe(true);
  });

  test("provides its own class symbol", () => {
    const declaration = classDeclaration();

    const outcome = analyze(declaration);

    expect(outcome.draft?.provider.provides.map((symbol) => symbol.key)).toEqual([
      `${fileId}#class:Service`,
    ]);
  });
});
