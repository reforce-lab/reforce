import { describe, expect, test } from "vitest";
import type { CompilerDiagnostic } from "@/api";
import { createExportBinder } from "@/linking/export-binding";
import { createModuleRecord } from "@/linking/module-record";
import type { ModuleRecord, ModuleResolver } from "@/linking/module-resolver";
import type {
  ClassDeclaration,
  ExportDeclaration,
  ImportDeclaration,
  SourceFileIr,
} from "@/parser/source-ir";
import type { CanonicalFileId, SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

// 这些用例只关心「某个名字最终绑定到哪个符号」，所以模块图直接用内存 map 伪造：specifier 就是模块名，
// 路径解析是 module-resolver 的职责，不在本层（Issue #117）。span 恒定，绑定语义不读它。

function span(file: string): SourceSpan {
  const fileId = file as CanonicalFileId; // 单测自造的模块图没有经过 source discovery，这里补上它本该颁发的不透明身份。
  return {
    fileId,
    start: { offset: 0, line: 0, character: 0 },
    end: { offset: 1, line: 0, character: 1 },
  };
}

interface ModuleShape {
  readonly classes?: readonly ClassDeclaration[];
  readonly imports?: readonly ImportDeclaration[];
  readonly exports?: readonly ExportDeclaration[];
}

function classDeclaration(file: string, name: string, exported: boolean): ClassDeclaration {
  return {
    kind: "class",
    topLevel: true,
    abstract: false,
    name,
    export: exported ? { kind: "named", exportedName: name, span: span(file) } : { kind: "none" },
    generic: false,
    decorators: [],
    fields: [],
    implements: [],
    constructors: [],
    methods: [],
    span: span(file),
  };
}

function namedImport(file: string, moduleSpecifier: string, name: string): ImportDeclaration {
  return {
    kind: "import",
    moduleSpecifier,
    bindings: [{ kind: "named", imported: name, local: name, span: span(file) }],
    span: span(file),
  };
}

function defaultImport(file: string, moduleSpecifier: string, local: string): ImportDeclaration {
  return {
    kind: "import",
    moduleSpecifier,
    bindings: [{ kind: "default", local, span: span(file) }],
    span: span(file),
  };
}

function starExport(file: string, moduleSpecifier: string): ExportDeclaration {
  return { kind: "reexport-all", moduleSpecifier, span: span(file) };
}

function namespaceExport(
  file: string,
  moduleSpecifier: string,
  exported: string,
): ExportDeclaration {
  return { kind: "namespace", moduleSpecifier, exported, span: span(file) };
}

function localNamedExport(file: string, local: string, exported: string): ExportDeclaration {
  return {
    kind: "local-named",
    specifiers: [{ local, exported, span: span(file) }],
    span: span(file),
  };
}

function parsedSource(file: string, shape: ModuleShape): ParsedSource {
  const unit: SourceFileIr = {
    imports: shape.imports ?? [],
    exports: shape.exports ?? [],
    interfaces: [],
    namespaces: [],
    classes: shape.classes ?? [],
    beanFactories: [],
    applicationDefinitions: [],
    configFactoryCalls: [],
    valueDeclarations: [],
    unsupportedDeclarations: [],
  };
  return {
    absolutePath: `/project/${file}`,
    fileId: file as CanonicalFileId, // 同上：伪造的模块图自行承担 source discovery 的规范化。
    sourceKind: "ts",
    unit,
  };
}

interface Harness {
  readonly binder: ReturnType<typeof createExportBinder>;
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly entry: ModuleRecord;
}

// 模块图的 key 是 specifier 本身，entry 模块固定叫 "entry"，其余模块用自己的 specifier 互相引用。
function harnessFor(modules: Readonly<Record<string, ModuleShape>>): Harness {
  const records = new Map<string, ModuleRecord>();
  for (const [specifier, shape] of Object.entries(modules)) {
    records.set(specifier, createModuleRecord(parsedSource(`${specifier}.ts`, shape)));
  }
  const diagnostics: CompilerDiagnostic[] = [];
  const resolveModule: ModuleResolver = (_containing, specifier) => {
    const record = records.get(specifier);
    return record === undefined ? undefined : { physicalPath: `/project/${specifier}.ts`, record };
  };
  const entry = records.get("entry");
  if (entry === undefined) {
    throw new Error("The module graph under test must contain an entry module.");
  }
  return {
    binder: createExportBinder({ diagnostics, resolveModule }),
    diagnostics,
    entry,
  };
}

describe("named export binding", () => {
  test("binds an imported name to the exported class of the target module", () => {
    const { binder, entry } = harnessFor({
      entry: { imports: [namedImport("entry.ts", "service", "Service")] },
      service: { classes: [classDeclaration("service.ts", "Service", true)] },
    });

    const symbol = binder.resolveLocal(entry, "Service");

    expect(symbol).toMatchObject({
      kind: "class",
      name: "Service",
      key: "service.ts#class:Service",
    });
  });

  test("binds an imported name through a single star export", () => {
    const { binder, entry } = harnessFor({
      entry: { imports: [namedImport("entry.ts", "hub", "Service")] },
      hub: { exports: [starExport("hub.ts", "service")] },
      service: { classes: [classDeclaration("service.ts", "Service", true)] },
    });

    const symbol = binder.resolveLocal(entry, "Service");

    expect(symbol).toMatchObject({ key: "service.ts#class:Service" });
  });
});

describe("star export ambiguity", () => {
  test("reports AMBIGUOUS_RE_EXPORT when two star exports provide the same name", () => {
    const { binder, entry, diagnostics } = harnessFor({
      entry: { imports: [namedImport("entry.ts", "hub", "Service")] },
      hub: { exports: [starExport("hub.ts", "left"), starExport("hub.ts", "right")] },
      left: { classes: [classDeclaration("left.ts", "Service", true)] },
      right: { classes: [classDeclaration("right.ts", "Service", true)] },
    });

    const symbol = binder.resolveLocal(entry, "Service");

    expect(symbol).toBeUndefined();
    expect(diagnostics).toMatchObject([
      {
        code: "AMBIGUOUS_RE_EXPORT",
        related: [{ message: "left.ts#class:Service" }, { message: "right.ts#class:Service" }],
      },
    ]);
  });

  test("keeps a name unambiguous when both star exports reach the same declaration", () => {
    const { binder, entry, diagnostics } = harnessFor({
      entry: { imports: [namedImport("entry.ts", "hub", "Service")] },
      hub: { exports: [starExport("hub.ts", "left"), starExport("hub.ts", "right")] },
      left: { exports: [starExport("left.ts", "service")] },
      right: { exports: [starExport("right.ts", "service")] },
      service: { classes: [classDeclaration("service.ts", "Service", true)] },
    });

    const symbol = binder.resolveLocal(entry, "Service");

    expect(symbol).toMatchObject({ key: "service.ts#class:Service" });
    expect(diagnostics).toHaveLength(0);
  });
});

describe("re-export cycles", () => {
  test("gives up instead of recursing when two modules star-export each other", () => {
    const { binder, entry } = harnessFor({
      entry: { imports: [namedImport("entry.ts", "left", "Missing")] },
      left: { exports: [starExport("left.ts", "right")] },
      right: { exports: [starExport("right.ts", "left")] },
    });

    const symbol = binder.resolveLocal(entry, "Missing");

    expect(symbol).toBeUndefined();
  });

  test("still binds a name that a cyclic module provides itself", () => {
    const { binder, entry } = harnessFor({
      entry: { imports: [namedImport("entry.ts", "left", "Service")] },
      left: { exports: [starExport("left.ts", "right")] },
      right: {
        classes: [classDeclaration("right.ts", "Service", true)],
        exports: [starExport("right.ts", "left")],
      },
    });

    const symbol = binder.resolveLocal(entry, "Service");

    expect(symbol).toMatchObject({ key: "right.ts#class:Service" });
  });
});

describe("default export exclusion", () => {
  test("does not let a star export provide the default binding", () => {
    const { binder, entry } = harnessFor({
      entry: { imports: [defaultImport("entry.ts", "hub", "Service")] },
      hub: { exports: [starExport("hub.ts", "service")] },
      service: {
        classes: [classDeclaration("service.ts", "Service", false)],
        exports: [localNamedExport("service.ts", "Service", "default")],
      },
    });

    const symbol = binder.resolveLocal(entry, "Service");

    expect(symbol).toBeUndefined();
  });

  test("binds the default import when the target module exports it by name", () => {
    const { binder, entry } = harnessFor({
      entry: { imports: [defaultImport("entry.ts", "service", "Service")] },
      service: {
        classes: [classDeclaration("service.ts", "Service", false)],
        exports: [localNamedExport("service.ts", "Service", "default")],
      },
    });

    const symbol = binder.resolveLocal(entry, "Service");

    expect(symbol).toMatchObject({ key: "service.ts#class:Service" });
  });
});

// 外部（npm 包）文件如今由 external-modules 建成同构 ModuleRecord 走同一算法（ADR 0004 决策 7，#120）；
// 这里只钉住两条边界：没有记录的解析目标解析不出符号，标记为歧义的导出名拒绝解析。
describe("external module records", () => {
  test("resolves to nothing when the resolved module carries no record", () => {
    const entry = createModuleRecord(
      parsedSource("entry.ts", { imports: [namedImport("entry.ts", "vendor", "Client")] }),
    );
    const resolveModule: ModuleResolver = () => ({ physicalPath: "/project/vendor.js" });
    const binder = createExportBinder({ diagnostics: [], resolveModule });

    const symbol = binder.resolveLocal(entry, "Client");

    expect(symbol).toBeUndefined();
  });

  test("refuses to resolve an exported name the record marks as ambiguous", () => {
    const entry = createModuleRecord(
      parsedSource("entry.ts", { imports: [namedImport("entry.ts", "vendor", "Port")] }),
    );
    const vendor: ModuleRecord = {
      ...createModuleRecord(
        parsedSource("vendor.ts", { classes: [classDeclaration("vendor.ts", "Port", true)] }),
      ),
      ambiguousExports: new Set(["Port"]),
    };
    const resolveModule: ModuleResolver = (_containing, specifier) =>
      specifier === "vendor" ? { physicalPath: "/project/vendor.ts", record: vendor } : undefined;
    const binder = createExportBinder({ diagnostics: [], resolveModule });

    const symbol = binder.resolveLocal(entry, "Port");

    expect(symbol).toBeUndefined();
  });
});

describe("namespace re-export members", () => {
  test("binds a member of an `export * as` namespace to the target module export", () => {
    const { binder, entry } = harnessFor({
      entry: { imports: [namedImport("entry.ts", "hub", "api")] },
      hub: { exports: [namespaceExport("hub.ts", "service", "api")] },
      service: { classes: [classDeclaration("service.ts", "Service", true)] },
    });

    const namespace = binder.resolveLocal(entry, "api");
    const member = binder.resolveNamespaceMember(namespace?.key ?? "", "Service");

    expect(member).toMatchObject({ key: "service.ts#class:Service" });
  });

  test("returns nothing for a namespace key the binder never handed out", () => {
    const { binder } = harnessFor({ entry: {} });

    const member = binder.resolveNamespaceMember("namespace:unknown.ts#api:0", "Service");

    expect(member).toBeUndefined();
  });
});
