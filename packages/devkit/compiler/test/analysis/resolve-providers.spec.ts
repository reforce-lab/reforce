import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  type DependencyModel,
  type PendingDependency,
  type ProviderDraft,
  type ProviderModel,
  type ProviderOriginModel,
  providerId,
  type QualifierModel,
  type SingleDependencyModel,
  sourceReference,
} from "@/analysis/model";
import { resolveProviders } from "@/analysis/resolve-providers";
import type { CompilerDiagnostic } from "@/api";
import type { LinkedSymbol } from "@/linking/model";
import { emptyStarterLinkage } from "@/linking/starter-linking";
import type {
  NamespaceDeclaration,
  NamespaceExportedMember,
  SourceFileIr,
} from "@/parser/source-ir";
import type { ParsedSource } from "@/project/source-files";
import { canonicalFileId, span } from "./support/ir";

function parsedSource(
  file: string,
  namespaces: readonly NamespaceDeclaration[] = [],
): ParsedSource {
  const unit: SourceFileIr = {
    suppressions: [],
    imports: [],
    exports: [],
    interfaces: [],
    namespaces,
    classes: [],
    beanFactories: [],
    applicationDefinitions: [],
    configFactoryCalls: [],
    valueDeclarations: [],
    unsupportedDeclarations: [],
  };
  return {
    absolutePath: `/project/${file}`,
    fileId: canonicalFileId(file),
    sourceKind: "ts",
    unit,
  };
}

function namespaceDeclaration(
  file: string,
  name: string,
  members: readonly string[],
): NamespaceDeclaration {
  return {
    kind: "namespace",
    topLevel: true,
    name,
    export: { kind: "named", exportedName: name, span: span(file) },
    exportedMembers: members.map(
      (member, index): NamespaceExportedMember => ({
        kind: "value",
        name: member,
        span: span(file, 100 + index),
      }),
    ),
    span: span(file),
  };
}

function interfaceSymbol(
  file: string,
  name: string,
  namespaces: readonly NamespaceDeclaration[] = [],
): LinkedSymbol {
  return {
    key: `${file}#interface:${name}`,
    kind: "interface",
    name,
    moduleSpecifier: file,
    source: parsedSource(file, namespaces),
    generic: false,
  };
}

function classSymbol(file: string, name: string): LinkedSymbol {
  return {
    key: `${file}#class:${name}`,
    kind: "class",
    name,
    moduleSpecifier: file,
    source: parsedSource(file),
    generic: false,
  };
}

function externalClassSymbol(moduleSpecifier: string, name: string): LinkedSymbol {
  return {
    key: `${moduleSpecifier}#class:${name}`,
    kind: "class",
    name,
    moduleSpecifier,
    generic: false,
  };
}

interface ProviderInput {
  readonly file: string;
  readonly exportName: string;
  readonly kind?: ProviderModel["kind"];
  readonly offset?: number;
  readonly provides?: readonly LinkedSymbol[];
  readonly primary?: boolean;
  readonly scope?: ProviderModel["scope"];
  readonly qualifiers?: readonly QualifierModel[];
  readonly order?: number;
  readonly dependencies?: DependencyModel[];
}

function provider(input: ProviderInput): ProviderModel {
  const origin: ProviderOriginModel = { kind: "application", source: parsedSource(input.file) };
  const base = {
    id: providerId(input.file, input.exportName),
    origin,
    exportName: input.exportName,
    declarationSource: sourceReference(span(input.file, input.offset ?? 0)),
    provides: input.provides ?? [],
    scope: input.scope ?? "singleton",
    primary: input.primary ?? false,
    ...(input.order === undefined ? {} : { order: input.order }),
    qualifiers: input.qualifiers ?? [],
    dependencies: input.dependencies ?? [],
  };
  return input.kind === "factory"
    ? { ...base, kind: "factory", dispose: false }
    : { ...base, kind: "class", startHook: false, closeHook: false };
}

function draft(
  model: ProviderModel,
  pendingDependencies: readonly PendingDependency[] = [],
): ProviderDraft {
  return { provider: model, pendingDependencies };
}

interface PendingInput {
  readonly index?: number;
  readonly lazy?: boolean;
  readonly current?: boolean;
  readonly qualifierMember?: string;
}

function pending(symbol: LinkedSymbol, input: PendingInput = {}): PendingDependency {
  const index = input.index ?? 0;
  const site = span("src/consumer.ts", index);
  return {
    index,
    linkedType: {
      symbol,
      typeArguments: [],
      lazy: input.lazy ?? false,
      current: input.current ?? false,
      qualifierMember: input.qualifierMember,
      span: site,
    },
    sourceSpan: site,
  };
}

function collectionPending(symbol: LinkedSymbol, input: PendingInput = {}): PendingDependency {
  return { ...pending(symbol, input), collection: true };
}

function resolve(drafts: readonly ProviderDraft[]): readonly CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  resolveProviders(drafts, emptyStarterLinkage, diagnostics);
  return diagnostics;
}

function codesOf(diagnostics: readonly CompilerDiagnostic[]): readonly string[] {
  return diagnostics.map((item) => item.code);
}

const caseVariantArbitrary = fc
  .uniqueArray(fc.integer({ min: 0, max: 63 }), { minLength: 1, maxLength: 6 })
  .map((masks) =>
    masks.map((mask) =>
      [..."handler"]
        .map((letter, index) => ((mask >> index) % 2 === 1 ? letter.toUpperCase() : letter))
        .join(""),
    ),
  );

describe("provider resolution", () => {
  test("reports a portable Bean ID collision between exports differing only in letter case", () => {
    const drafts = [
      draft(provider({ file: "src/a.ts", exportName: "Service" })),
      draft(provider({ file: "src/a.ts", exportName: "service" })),
    ];

    const diagnostics = resolve(drafts);

    expect(codesOf(diagnostics)).toEqual(["BEAN_ID_COLLISION"]);
  });

  test("anchors a portable collision to the colliding declaration", () => {
    const drafts = [
      draft(provider({ file: "src/a.ts", exportName: "Service", offset: 10 })),
      draft(provider({ file: "src/a.ts", exportName: "service", offset: 42 })),
    ];

    const diagnostics = resolve(drafts);

    expect(diagnostics[0]?.sourceSpan).toEqual(span("src/a.ts", 42));
  });

  test("relates every later portable collision to the first registered identity", () => {
    const drafts = [
      draft(provider({ file: "src/a.ts", exportName: "Service" })),
      draft(provider({ file: "src/a.ts", exportName: "service" })),
      draft(provider({ file: "src/a.ts", exportName: "SERVICE" })),
    ];

    const diagnostics = resolve(drafts);

    expect(diagnostics.map((item) => item.related.map((entry) => entry.message))).toEqual([
      ["src/a.ts#Service", "src/a.ts#service"],
      ["src/a.ts#SERVICE", "src/a.ts#Service"],
    ]);
  });

  test("reports one portable collision per extra case variant of a Bean ID", () => {
    fc.assert(
      fc.property(caseVariantArbitrary, (exportNames) => {
        const drafts = exportNames.map((exportName) =>
          draft(provider({ file: "src/a.ts", exportName })),
        );

        const diagnostics = resolve(drafts);

        expect(codesOf(diagnostics)).toEqual(
          Array.from({ length: exportNames.length - 1 }, () => "BEAN_ID_COLLISION"),
        );
      }),
    );
  });

  test("rejects a qualifier member that is a reserved word", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const drafts = [
      draft(
        provider({
          file: "src/a.ts",
          exportName: "Service",
          provides: [port],
          qualifiers: [{ interfaceSymbol: port, member: "class" }],
        }),
      ),
    ];

    const diagnostics = resolve(drafts);

    expect(codesOf(diagnostics)).toEqual(["INVALID_BEAN_QUALIFIER"]);
  });

  test("rejects a qualifier member that is not a TypeScript identifier", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const drafts = [
      draft(
        provider({
          file: "src/a.ts",
          exportName: "Service",
          provides: [port],
          qualifiers: [{ interfaceSymbol: port, member: "fast-handler" }],
        }),
      ),
    ];

    const diagnostics = resolve(drafts);

    expect(codesOf(diagnostics)).toEqual(["INVALID_BEAN_QUALIFIER"]);
  });

  test("excludes an invalid qualifier member from the qualifier index", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const drafts = [
      draft(
        provider({
          file: "src/a.ts",
          exportName: "Service",
          provides: [port],
          qualifiers: [{ interfaceSymbol: port, member: "class" }],
        }),
      ),
      draft(provider({ file: "src/c.ts", exportName: "Consumer" }), [
        pending(port, { qualifierMember: "class" }),
      ]),
    ];

    const diagnostics = resolve(drafts);

    expect(codesOf(diagnostics)).toEqual(["INVALID_BEAN_QUALIFIER", "UNKNOWN_BEAN_QUALIFIER"]);
  });

  test("reports a qualifier member that already exists in the source namespace", () => {
    const port = interfaceSymbol("src/port.ts", "Port", [
      namespaceDeclaration("src/port.ts", "Port", ["Handler"]),
    ]);
    const drafts = [
      draft(
        provider({
          file: "src/a.ts",
          exportName: "Handler",
          provides: [port],
          qualifiers: [{ interfaceSymbol: port, member: "Handler" }],
        }),
      ),
    ];

    const diagnostics = resolve(drafts);

    expect(codesOf(diagnostics)).toEqual(["DUPLICATE_BEAN_QUALIFIER"]);
    expect(diagnostics[0]?.sourceSpan).toEqual(span("src/port.ts", 100));
  });

  test("reports a namespace qualifier collision once even when several Beans publish that member", () => {
    const port = interfaceSymbol("src/port.ts", "Port", [
      namespaceDeclaration("src/port.ts", "Port", ["Handler"]),
    ]);
    const qualifiers = [{ interfaceSymbol: port, member: "Handler" }];
    const drafts = [
      draft(provider({ file: "src/a.ts", exportName: "First", provides: [port], qualifiers })),
      draft(provider({ file: "src/b.ts", exportName: "Second", provides: [port], qualifiers })),
    ];

    const diagnostics = resolve(drafts);

    expect(
      diagnostics.filter((item) => item.message.includes("already exists in the source namespace")),
    ).toHaveLength(1);
  });

  test("rejects two Beans publishing the same qualifier member for one interface", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const qualifiers = [{ interfaceSymbol: port, member: "handler" }];
    const drafts = [
      draft(provider({ file: "src/a.ts", exportName: "First", provides: [port], qualifiers })),
      draft(provider({ file: "src/b.ts", exportName: "Second", provides: [port], qualifiers })),
    ];

    const diagnostics = resolve(drafts);

    expect(codesOf(diagnostics)).toEqual(["DUPLICATE_BEAN_QUALIFIER"]);
    expect(diagnostics[0]?.message).toBe("Port.handler is provided by multiple Beans.");
  });

  test("reports multiple Primary Beans providing one interface", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const drafts = [
      draft(provider({ file: "src/a.ts", exportName: "First", provides: [port], primary: true })),
      draft(provider({ file: "src/b.ts", exportName: "Second", provides: [port], primary: true })),
    ];

    const diagnostics = resolve(drafts);

    expect(codesOf(diagnostics)).toEqual(["MULTIPLE_PRIMARY_BEANS"]);
    expect(diagnostics[0]?.related.map((entry) => entry.message)).toEqual([
      "src/a.ts#First",
      "src/b.ts#Second",
    ]);
  });

  test("does not report ambiguity when the Primary Beans are themselves ambiguous", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const drafts = [
      draft(provider({ file: "src/a.ts", exportName: "First", provides: [port], primary: true })),
      draft(provider({ file: "src/b.ts", exportName: "Second", provides: [port], primary: true })),
      draft(provider({ file: "src/c.ts", exportName: "Consumer" }), [pending(port)]),
    ];

    const diagnostics = resolve(drafts);

    expect(codesOf(diagnostics)).toEqual(["MULTIPLE_PRIMARY_BEANS"]);
  });

  test("leaves a dependency unresolved when several Primary Beans provide the interface", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const dependencies: SingleDependencyModel[] = [];
    const drafts = [
      draft(provider({ file: "src/a.ts", exportName: "First", provides: [port], primary: true })),
      draft(provider({ file: "src/b.ts", exportName: "Second", provides: [port], primary: true })),
      draft(provider({ file: "src/c.ts", exportName: "Consumer", dependencies }), [pending(port)]),
    ];

    resolveProviders(drafts, emptyStarterLinkage, []);

    expect(dependencies).toEqual([]);
  });

  test("reports ambiguity when several Beans provide an interface and none is Primary", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const drafts = [
      draft(provider({ file: "src/a.ts", exportName: "First", provides: [port] })),
      draft(provider({ file: "src/b.ts", exportName: "Second", provides: [port] })),
      draft(provider({ file: "src/c.ts", exportName: "Consumer" }), [pending(port)]),
    ];

    const diagnostics = resolve(drafts);

    expect(codesOf(diagnostics)).toEqual(["AMBIGUOUS_BEAN"]);
    expect(diagnostics[0]?.related.map((entry) => entry.message)).toEqual([
      "src/a.ts#First",
      "src/b.ts#Second",
    ]);
  });

  test("reports a missing Injectable when nothing provides a concrete class", () => {
    const service = classSymbol("src/service.ts", "Service");
    const drafts = [
      draft(provider({ file: "src/c.ts", exportName: "Consumer" }), [pending(service)]),
    ];

    const diagnostics = resolve(drafts);

    expect(codesOf(diagnostics)).toEqual(["MISSING_BEAN"]);
    expect(diagnostics[0]?.message).toBe("No Injectable Bean provides Service.");
  });

  test("reports a missing Bean when nothing provides an interface", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const drafts = [draft(provider({ file: "src/c.ts", exportName: "Consumer" }), [pending(port)])];

    const diagnostics = resolve(drafts);

    expect(codesOf(diagnostics)).toEqual(["MISSING_BEAN"]);
    expect(diagnostics[0]?.message).toBe("No Bean provides Port.");
  });

  test("reports a missing Injectable for an externally declared class", () => {
    const external = externalClassSymbol("vendor", "Client");
    const drafts = [
      draft(provider({ file: "src/c.ts", exportName: "Consumer" }), [pending(external)]),
    ];

    const diagnostics = resolve(drafts);

    expect(diagnostics[0]?.message).toBe("No Injectable Bean provides Client.");
  });

  test("reports an unknown qualifier member", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const drafts = [
      draft(
        provider({
          file: "src/a.ts",
          exportName: "Service",
          provides: [port],
          qualifiers: [{ interfaceSymbol: port, member: "fast" }],
        }),
      ),
      draft(provider({ file: "src/c.ts", exportName: "Consumer" }), [
        pending(port, { qualifierMember: "slow" }),
      ]),
    ];

    const diagnostics = resolve(drafts);

    expect(codesOf(diagnostics)).toEqual(["UNKNOWN_BEAN_QUALIFIER"]);
  });

  test("lists every available qualifier member when a qualifier is unknown", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const drafts = [
      draft(
        provider({
          file: "src/a.ts",
          exportName: "Service",
          provides: [port],
          qualifiers: [{ interfaceSymbol: port, member: "fast" }],
        }),
      ),
      draft(provider({ file: "src/c.ts", exportName: "Consumer" }), [
        pending(port, { qualifierMember: "slow" }),
      ]),
    ];

    const diagnostics = resolve(drafts);

    expect(diagnostics[0]?.related.map((entry) => entry.message)).toEqual([
      "fast -> src/a.ts#Service (Primary: false)",
    ]);
  });

  test("leaves a qualified dependency unresolved instead of falling back to the Primary Bean", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const dependencies: SingleDependencyModel[] = [];
    const drafts = [
      draft(
        provider({
          file: "src/a.ts",
          exportName: "Service",
          provides: [port],
          primary: true,
          qualifiers: [{ interfaceSymbol: port, member: "fast" }],
        }),
      ),
      draft(provider({ file: "src/c.ts", exportName: "Consumer", dependencies }), [
        pending(port, { qualifierMember: "slow" }),
      ]),
    ];

    resolveProviders(drafts, emptyStarterLinkage, []);

    expect(dependencies).toEqual([]);
  });

  test("selects the only Bean that provides an interface", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const dependencies: SingleDependencyModel[] = [];
    const drafts = [
      draft(provider({ file: "src/a.ts", exportName: "Service", provides: [port] })),
      draft(provider({ file: "src/c.ts", exportName: "Consumer", dependencies }), [pending(port)]),
    ];

    resolveProviders(drafts, emptyStarterLinkage, []);

    expect(dependencies.map((item) => item.targetId)).toEqual(["src/a.ts#Service"]);
  });

  test("selects the Primary Bean among several interface candidates", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const dependencies: SingleDependencyModel[] = [];
    const drafts = [
      draft(provider({ file: "src/a.ts", exportName: "First", provides: [port] })),
      draft(provider({ file: "src/b.ts", exportName: "Second", provides: [port], primary: true })),
      draft(provider({ file: "src/c.ts", exportName: "Consumer", dependencies }), [pending(port)]),
    ];

    resolveProviders(drafts, emptyStarterLinkage, []);

    expect(dependencies.map((item) => item.targetId)).toEqual(["src/b.ts#Second"]);
  });

  test("selects the qualified Bean instead of the Primary Bean", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const dependencies: SingleDependencyModel[] = [];
    const drafts = [
      draft(
        provider({
          file: "src/a.ts",
          exportName: "First",
          provides: [port],
          qualifiers: [{ interfaceSymbol: port, member: "slow" }],
        }),
      ),
      draft(provider({ file: "src/b.ts", exportName: "Second", provides: [port], primary: true })),
      draft(provider({ file: "src/c.ts", exportName: "Consumer", dependencies }), [
        pending(port, { qualifierMember: "slow" }),
      ]),
    ];

    resolveProviders(drafts, emptyStarterLinkage, []);

    expect(dependencies.map((item) => item.targetId)).toEqual(["src/a.ts#First"]);
  });

  test("selects a class's own Injectable provider over a Primary factory for that class", () => {
    const concrete = classSymbol("src/a.ts", "Concrete");
    const dependencies: SingleDependencyModel[] = [];
    const drafts = [
      draft(provider({ file: "src/a.ts", exportName: "Concrete", provides: [concrete] })),
      draft(
        provider({
          file: "src/a.ts",
          exportName: "concreteFactory",
          kind: "factory",
          provides: [concrete],
          primary: true,
        }),
      ),
      draft(provider({ file: "src/c.ts", exportName: "Consumer", dependencies }), [
        pending(concrete),
      ]),
    ];

    resolveProviders(drafts, emptyStarterLinkage, []);

    expect(dependencies.map((item) => item.targetId)).toEqual(["src/a.ts#Concrete"]);
  });

  test("records an explicitly lazy dependency as explicit-lazy", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const dependencies: SingleDependencyModel[] = [];
    const drafts = [
      draft(provider({ file: "src/a.ts", exportName: "Service", provides: [port] })),
      draft(provider({ file: "src/c.ts", exportName: "Consumer", dependencies }), [
        pending(port, { lazy: true }),
      ]),
    ];

    resolveProviders(drafts, emptyStarterLinkage, []);

    expect(dependencies.map((item) => item.mode)).toEqual(["explicit-lazy"]);
  });

  test("records the resolved dependency with its parameter index and injection site", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const dependencies: SingleDependencyModel[] = [];
    const drafts = [
      draft(provider({ file: "src/a.ts", exportName: "Service", provides: [port] })),
      draft(provider({ file: "src/c.ts", exportName: "Consumer", dependencies }), [
        pending(port, { index: 2 }),
      ]),
    ];

    resolveProviders(drafts, emptyStarterLinkage, []);

    expect(dependencies).toEqual([
      {
        parameterIndex: 2,
        targetId: "src/a.ts#Service",
        mode: "eager",
        source: sourceReference(span("src/consumer.ts", 2)),
        contract: port,
      },
    ]);
  });
});

describe("collection membership", () => {
  test("every provider of the contract joins ordered by @Order then beanId", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const dependencies: DependencyModel[] = [];
    const drafts = [
      draft(provider({ file: "src/a.ts", exportName: "Unordered", provides: [port] })),
      draft(provider({ file: "src/b.ts", exportName: "Late", provides: [port], order: 10 })),
      draft(provider({ file: "src/c.ts", exportName: "Tied", provides: [port], order: 1 })),
      draft(provider({ file: "src/b.ts", exportName: "AlsoTied", provides: [port], order: 1 })),
      draft(provider({ file: "src/d.ts", exportName: "Consumer", dependencies }), [
        collectionPending(port),
      ]),
    ];

    const diagnostics = resolve(drafts);

    expect(diagnostics).toEqual([]);
    const dependency = dependencies[0];
    if (dependency === undefined || !("members" in dependency)) {
      throw new Error("Expected one collection dependency.");
    }
    expect(dependency.members).toEqual([
      { targetId: "src/b.ts#AlsoTied", mode: "eager" },
      { targetId: "src/c.ts#Tied", mode: "eager" },
      { targetId: "src/b.ts#Late", mode: "eager" },
      { targetId: "src/a.ts#Unordered", mode: "eager" },
    ]);
    expect(dependency.contract).toBe(port);
  });

  test("an empty membership resolves to an empty collection without diagnostics", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const dependencies: DependencyModel[] = [];
    const drafts = [
      draft(provider({ file: "src/d.ts", exportName: "Consumer", dependencies }), [
        collectionPending(port),
      ]),
    ];

    const diagnostics = resolve(drafts);

    expect(diagnostics).toEqual([]);
    const dependency = dependencies[0];
    if (dependency === undefined || !("members" in dependency)) {
      throw new Error("Expected one collection dependency.");
    }
    expect(dependency.members).toEqual([]);
  });

  test("a collection does not consult Primary and reports no ambiguity", () => {
    const port = interfaceSymbol("src/port.ts", "Port");
    const dependencies: DependencyModel[] = [];
    const drafts = [
      draft(provider({ file: "src/a.ts", exportName: "First", provides: [port] })),
      draft(provider({ file: "src/b.ts", exportName: "Second", provides: [port], primary: true })),
      draft(provider({ file: "src/d.ts", exportName: "Consumer", dependencies }), [
        collectionPending(port),
      ]),
    ];

    const diagnostics = resolve(drafts);

    expect(diagnostics).toEqual([]);
    const dependency = dependencies[0];
    if (dependency === undefined || !("members" in dependency)) {
      throw new Error("Expected one collection dependency.");
    }
    expect(dependency.members.map((member) => member.targetId)).toEqual([
      "src/a.ts#First",
      "src/b.ts#Second",
    ]);
  });
});

// 同名包两份物理拷贝的撕裂检测（#253）：coordinate 相同、key 不同、且都被实际绑定才报。
describe("split contract bindings", () => {
  function copiedContractSymbol(root: string, name: string): LinkedSymbol {
    return {
      key: `package:${root}:dist/index.d.ts#interface:${name}`,
      kind: "interface",
      name,
      moduleSpecifier: "shared-contract",
      generic: false,
      external: {
        packageName: "shared-contract",
        version: "1.0.0",
        packageRoot: root,
        coordinate: `shared-contract:dist/index.d.ts#${name}`,
      },
    };
  }

  const leftPort = copiedContractSymbol("/packages/left", "Port");
  const rightPort = copiedContractSymbol("/packages/right", "Port");

  test("warns once when two copies of one contract both get bound", () => {
    const drafts = [
      draft(provider({ file: "src/left/a.ts", exportName: "LeftProvider", provides: [leftPort] })),
      draft(
        provider({ file: "src/right/a.ts", exportName: "RightProvider", provides: [rightPort] }),
      ),
      draft(provider({ file: "src/left/c.ts", exportName: "LeftConsumer" }), [pending(leftPort)]),
      draft(provider({ file: "src/right/c.ts", exportName: "RightConsumer" }), [
        pending(rightPort),
      ]),
    ];

    const diagnostics = resolve(drafts);

    expect(diagnostics.map((item) => [item.code, item.severity])).toEqual([
      ["SPLIT_CONTRACT_BINDING", "warning"],
    ]);
    expect(diagnostics[0]?.message).toContain("shared-contract");
  });

  test("stays silent when only one copy is bound", () => {
    const drafts = [
      draft(provider({ file: "src/left/a.ts", exportName: "LeftProvider", provides: [leftPort] })),
      draft(
        provider({ file: "src/right/a.ts", exportName: "RightProvider", provides: [rightPort] }),
      ),
      draft(provider({ file: "src/left/c.ts", exportName: "LeftConsumer" }), [pending(leftPort)]),
    ];

    expect(resolve(drafts)).toEqual([]);
  });

  test("a collection binding counts toward the split", () => {
    const drafts = [
      draft(provider({ file: "src/left/a.ts", exportName: "LeftProvider", provides: [leftPort] })),
      draft(
        provider({ file: "src/right/a.ts", exportName: "RightProvider", provides: [rightPort] }),
      ),
      draft(provider({ file: "src/left/c.ts", exportName: "LeftConsumer" }), [pending(leftPort)]),
      draft(provider({ file: "src/right/c.ts", exportName: "RightConsumer" }), [
        collectionPending(rightPort),
      ]),
    ];

    const diagnostics = resolve(drafts);

    expect(diagnostics.map((item) => item.code)).toEqual(["SPLIT_CONTRACT_BINDING"]);
  });
});
