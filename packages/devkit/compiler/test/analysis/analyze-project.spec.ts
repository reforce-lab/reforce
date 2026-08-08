import { describe, expect, test } from "vitest";
import { analyzeProject } from "@/analysis/analyze-project";
import type { CompilerDiagnostic } from "@/api";
import type { LinkedSymbol } from "@/linking/model";
import type { ProjectLinker } from "@/linking/project-linker";
import { emptyStarterLinkage } from "@/linking/starter-linking";
import type {
  ClassDeclaration,
  DecoratorUse,
  EntityName,
  ExportDeclaration,
  ImportDeclaration,
  SourceFileIr,
  SourceKind,
} from "@/parser/source-ir";
import type { ParsedSource } from "@/project/source-files";
import { canonicalFileId, span } from "./support/ir";

function identifier(name: string, file: string): EntityName {
  return { kind: "identifier", name, span: span(file) };
}

function injectableDecorator(file: string): DecoratorUse {
  return {
    kind: "decorator",
    callee: identifier("Injectable", file),
    called: true,
    arguments: [],
    span: span(file),
  };
}

function injectableClass(file: string, name: string): ClassDeclaration {
  return {
    kind: "class",
    topLevel: true,
    abstract: false,
    name,
    export: { kind: "named", exportedName: name, span: span(file) },
    generic: false,
    decorators: [injectableDecorator(file)],
    fields: [],
    implements: [],
    constructors: [],
    methods: [],
    span: span(file),
  };
}

interface SourceOptions {
  readonly sourceKind?: SourceKind;
  readonly classes?: readonly ClassDeclaration[];
  readonly imports?: readonly ImportDeclaration[];
  readonly exports?: readonly ExportDeclaration[];
}

function parsedSource(file: string, options: SourceOptions = {}): ParsedSource {
  const unit: SourceFileIr = {
    suppressions: [],
    imports: options.imports ?? [],
    exports: options.exports ?? [],
    interfaces: [],
    namespaces: [],
    classes: options.classes ?? [],
    beanFactories: [],
    applicationDefinitions: [],
    configFactoryCalls: [],
    valueDeclarations: [],
    unsupportedDeclarations: [],
  };
  return {
    absolutePath: `/project/${file}`,
    fileId: canonicalFileId(file),
    sourceKind: options.sourceKind ?? "ts",
    unit,
  };
}

// The real linker resolves modules and external declarations through the filesystem; analysis only
// needs the Injectable entity and a class identity, so an in-memory stand-in is enough here.
function createLinker(diagnostics: readonly CompilerDiagnostic[] = []): ProjectLinker {
  return {
    diagnostics,
    starterLinkage: emptyStarterLinkage,
    collectWatchInputs: () => ({
      fileDependencies: [],
      contextDependencies: [],
      missingDependencies: [],
    }),
    resolveValueDeclaration: () => undefined,
    resolveEntity(_source, entity): LinkedSymbol | undefined {
      if (entity.kind !== "identifier" || entity.name !== "Injectable") {
        return undefined;
      }
      return {
        key: "@reforce/core#Injectable",
        kind: "core",
        name: entity.name,
        moduleSpecifier: "@reforce/core",
        generic: false,
      };
    },
    resolveType() {
      return undefined;
    },
    symbolForDeclaration(source, declaration): LinkedSymbol | undefined {
      const name = declaration.name;
      if (name === undefined) {
        return undefined;
      }
      return {
        key: `${source.fileId}#${declaration.kind}:${name}`,
        kind: declaration.kind,
        name,
        moduleSpecifier: source.fileId,
        source,
        declaration,
        generic: declaration.generic,
      };
    },
  };
}

function providerIds(result: ReturnType<typeof analyzeProject>): readonly string[] {
  if (result.status === "failure") {
    throw new Error(result.diagnostics.map((item) => item.code).join(", "));
  }
  return result.providers.map((provider) => provider.id);
}

function diagnosticCodes(result: ReturnType<typeof analyzeProject>): readonly string[] {
  if (result.status === "success") {
    throw new Error("Expected the analysis to fail");
  }
  return result.diagnostics.map((item) => item.code);
}

describe("project analysis", () => {
  test("skips declaration sources when collecting providers", () => {
    const sources = [
      parsedSource("src/ambient.d.ts", {
        sourceKind: "d.ts",
        classes: [injectableClass("src/ambient.d.ts", "Service")],
      }),
    ];

    const result = analyzeProject(sources, createLinker());

    expect(providerIds(result)).toEqual([]);
  });

  test("reports unsupported import syntax", () => {
    const sources = [
      parsedSource("src/application.ts", {
        imports: [
          {
            kind: "unsupported-import",
            syntaxKind: "import-equals",
            span: span("src/application.ts"),
          },
        ],
      }),
    ];

    const result = analyzeProject(sources, createLinker());

    expect(diagnosticCodes(result)).toEqual(["UNSUPPORTED_MODULE_SYNTAX"]);
  });

  test("reports unsupported export syntax", () => {
    const sources = [
      parsedSource("src/application.ts", {
        exports: [
          {
            kind: "unsupported-export",
            syntaxKind: "export-assignment",
            span: span("src/application.ts"),
          },
        ],
      }),
    ];

    const result = analyzeProject(sources, createLinker());

    expect(diagnosticCodes(result)).toEqual(["UNSUPPORTED_MODULE_SYNTAX"]);
  });

  test("fails when the linker carries diagnostics", () => {
    const linkerDiagnostic: CompilerDiagnostic = {
      kind: "compiler",
      code: "MODULE_RESOLUTION_FAILED",
      severity: "error",
      message: "The linker already reported this failure.",
      related: [],
    };
    const sources = [parsedSource("src/application.ts")];

    const result = analyzeProject(sources, createLinker([linkerDiagnostic]));

    expect(diagnosticCodes(result)).toEqual(["MODULE_RESOLUTION_FAILED"]);
  });

  test("orders successful providers by Bean ID", () => {
    const sources = [
      parsedSource("src/zeta.ts", { classes: [injectableClass("src/zeta.ts", "Zeta")] }),
      parsedSource("src/alpha.ts", { classes: [injectableClass("src/alpha.ts", "Alpha")] }),
    ];

    const result = analyzeProject(sources, createLinker());

    expect(providerIds(result)).toEqual(["src/alpha.ts#Alpha", "src/zeta.ts#Zeta"]);
  });
});
