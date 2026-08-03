import { isBuiltin } from "node:module";
import { compareUtf16CodeUnits } from "@reforce/primitives";
import type { LRUCache } from "lru-cache";
import type { CompilerDiagnostic, CompilerWatchInputs, ResolvedApplicationProject } from "@/api";
import { diagnostic } from "@/diagnostics";
import {
  type ExternalDeclaration,
  readExternalDeclarations,
} from "@/linking/external-declarations";
import type { LinkedSymbol, LinkedType } from "@/linking/model";
import {
  createModuleResolver,
  type ImportReference,
  type ModuleRecord,
  type ModuleResolver,
  moduleKey,
  type ResolvedModule,
} from "@/linking/module-resolver";
import type {
  ClassDeclaration,
  EntityName,
  InterfaceDeclaration,
  SourceFileIr,
  TypeNode,
} from "@/parser/source-ir";
import type { ParsedSource } from "@/project/source-files";
import { createWatchInputs } from "@/project/watch-inputs";

const contextModuleSpecifier = "@reforce/context";

export interface ProjectLinker {
  readonly diagnostics: readonly CompilerDiagnostic[];
  collectWatchInputs(): CompilerWatchInputs;
  resolveEntity(source: ParsedSource, entity: EntityName): LinkedSymbol | undefined;
  resolveType(source: ParsedSource, type: TypeNode): LinkedType | undefined;
  symbolForDeclaration(
    source: ParsedSource,
    declaration: ClassDeclaration | InterfaceDeclaration,
  ): LinkedSymbol | undefined;
}

function entityText(entity: EntityName): string {
  return entity.kind === "identifier" ? entity.name : `${entityText(entity.left)}.${entity.right}`;
}

function createLocalSymbol(
  source: ParsedSource,
  declaration: ClassDeclaration | InterfaceDeclaration,
): LinkedSymbol | undefined {
  const name = declaration.name;
  if (name === undefined) {
    return undefined;
  }
  return Object.freeze({
    key: `${source.fileId}#${declaration.kind}:${name}`,
    kind: declaration.kind,
    name,
    moduleSpecifier: source.fileId,
    source,
    declaration,
    generic: declaration.generic,
  });
}

function localSymbolsFor(source: ParsedSource): ReadonlyMap<string, LinkedSymbol> {
  const localSymbols = new Map<string, LinkedSymbol>();
  for (const declaration of [...source.unit.interfaces, ...source.unit.classes]) {
    const symbol = createLocalSymbol(source, declaration);
    if (symbol !== undefined) {
      localSymbols.set(symbol.name, symbol);
    }
  }
  for (const declaration of source.unit.unsupportedDeclarations) {
    const name = declaration.name;
    if (name !== undefined) {
      localSymbols.set(
        name,
        Object.freeze({
          key: `${source.fileId}#unsupported:${name}`,
          kind: "unsupported",
          name,
          moduleSpecifier: source.fileId,
          source,
          generic: declaration.generic,
        }),
      );
    }
  }
  return localSymbols;
}

// unsupported 符号没有 declaration（LinkedSymbol.declaration 只容 class|interface），它是否被具名导出
// 只能从 IR 读回来。缺了这一步，跨模块的 `export type X = {}` 对 resolveExport 不可见，
// UNSUPPORTED_TYPE_DECLARATION 会退化成误导性的 TYPE_LINK_FAILED，而同文件的 `export { type X }`
// 却能正确解析（#109）。
function directlyExportedLocal(
  record: ModuleRecord,
  exportedName: string,
): LinkedSymbol | undefined {
  const direct = record.localSymbols.get(exportedName);
  if (direct === undefined) {
    return undefined;
  }
  if (direct.declaration?.export.kind === "named") {
    return direct;
  }
  if (direct.kind !== "unsupported") {
    return undefined;
  }
  // 没有导出修饰符的本地声明必须在这里保持不可见，否则会遮蔽只由 `export * from ...` 提供的同名符号。
  const exported = record.source.unit.unsupportedDeclarations.some(
    (item) => item.name === exportedName && item.export.kind === "named",
  );
  return exported ? direct : undefined;
}

function importReferencesFor(source: ParsedSource): ReadonlyMap<string, ImportReference> {
  const imports = new Map<string, ImportReference>();
  for (const declaration of source.unit.imports) {
    if (declaration.kind !== "import") {
      continue;
    }
    for (const binding of declaration.bindings) {
      if (binding.kind === "default") {
        imports.set(binding.local, {
          moduleSpecifier: declaration.moduleSpecifier,
          imported: "default",
          namespace: false,
        });
        continue;
      }
      if (binding.kind === "namespace") {
        imports.set(binding.local, {
          moduleSpecifier: declaration.moduleSpecifier,
          imported: "*",
          namespace: true,
        });
        continue;
      }
      imports.set(binding.local, {
        moduleSpecifier: declaration.moduleSpecifier,
        imported: binding.imported,
        namespace: false,
      });
    }
  }
  return imports;
}

function createModuleRecord(source: ParsedSource): ModuleRecord {
  return {
    source,
    localSymbols: localSymbolsFor(source),
    imports: importReferencesFor(source),
  };
}

function referencedModuleSpecifiers(source: ParsedSource): readonly string[] {
  const specifiers = new Set<string>();
  for (const declaration of source.unit.imports) {
    if (declaration.kind === "import") {
      specifiers.add(declaration.moduleSpecifier);
    }
  }
  for (const declaration of source.unit.exports) {
    if (
      declaration.kind === "reexport-named" ||
      declaration.kind === "reexport-all" ||
      declaration.kind === "namespace"
    ) {
      specifiers.add(declaration.moduleSpecifier);
    }
  }
  return [...specifiers];
}

async function loadExternalDeclarations(
  sources: readonly ParsedSource[],
  resolveModule: ModuleResolver,
  cache: LRUCache<string, SourceFileIr>,
): Promise<ReadonlyMap<string, ReadonlyMap<string, ExternalDeclaration> | undefined>> {
  const externalPaths = new Set<string>();
  for (const source of sources) {
    for (const specifier of referencedModuleSpecifiers(source)) {
      const target =
        specifier === contextModuleSpecifier || isBuiltin(specifier)
          ? undefined
          : resolveModule(source, specifier, false);
      if (target !== undefined && target.record === undefined) {
        externalPaths.add(target.physicalPath);
      }
    }
  }
  const result = new Map<string, ReadonlyMap<string, ExternalDeclaration> | undefined>();
  for (const physicalPath of [...externalPaths].sort(compareUtf16CodeUnits)) {
    result.set(physicalPath, await readExternalDeclarations(physicalPath, cache));
  }
  return result;
}

export async function createProjectLinker(
  sources: readonly ParsedSource[],
  project: ResolvedApplicationProject,
  cache: LRUCache<string, SourceFileIr>,
  customConditions: readonly string[] = [],
): Promise<ProjectLinker> {
  const records = new Map<string, ModuleRecord>();
  const recordsByFileId = new Map<string, ModuleRecord>();
  const diagnostics: CompilerDiagnostic[] = [];
  for (const source of sources) {
    const record = createModuleRecord(source);
    records.set(moduleKey(source.absolutePath), record);
    recordsByFileId.set(source.fileId, record);
  }
  const { resolveModule, collectWatchDependencies } = createModuleResolver(
    records,
    diagnostics,
    project,
    customConditions,
  );
  const externalDeclarations = await loadExternalDeclarations(sources, resolveModule, cache);

  interface NamedExportResolution {
    readonly matched: boolean;
    readonly symbol?: LinkedSymbol;
  }

  interface NamespaceTarget {
    readonly moduleSpecifier: string;
    readonly target: ResolvedModule;
  }

  const namespaceTargets = new Map<string, NamespaceTarget>();

  function resolveModuleExport(
    target: ResolvedModule,
    moduleSpecifier: string,
    exportedName: string,
    visited: Set<string>,
  ): LinkedSymbol | undefined {
    return target.record === undefined
      ? externalSymbol(moduleSpecifier, exportedName, target.physicalPath)
      : resolveExport(target.record, exportedName, visited);
  }

  function resolveLocalNamedExport(
    record: ModuleRecord,
    exportedName: string,
    visited: Set<string>,
  ): NamedExportResolution {
    for (const declaration of record.source.unit.exports) {
      if (declaration.kind !== "local-named") {
        continue;
      }
      const specifier = declaration.specifiers.find((item) => item.exported === exportedName);
      if (specifier !== undefined) {
        const symbol = resolveLocal(record, specifier.local, visited);
        return symbol === undefined ? { matched: true } : { matched: true, symbol };
      }
    }
    return { matched: false };
  }

  function resolveExportFromModule(
    record: ModuleRecord,
    moduleSpecifier: string,
    exportedName: string,
    visited: Set<string>,
  ): LinkedSymbol | undefined {
    const target = resolveModule(record.source, moduleSpecifier);
    if (target === undefined) {
      return undefined;
    }
    return resolveModuleExport(target, moduleSpecifier, exportedName, visited);
  }

  function resolveReexportedName(
    record: ModuleRecord,
    exportedName: string,
    visited: Set<string>,
  ): NamedExportResolution {
    for (const declaration of record.source.unit.exports) {
      if (declaration.kind !== "reexport-named") {
        continue;
      }
      const specifier = declaration.specifiers.find((item) => item.exported === exportedName);
      if (specifier !== undefined) {
        const symbol = resolveExportFromModule(
          record,
          declaration.moduleSpecifier,
          specifier.local,
          visited,
        );
        return symbol === undefined ? { matched: true } : { matched: true, symbol };
      }
    }
    return { matched: false };
  }

  function resolveNamespaceExport(
    record: ModuleRecord,
    exportedName: string,
  ): NamedExportResolution {
    const declaration = record.source.unit.exports.find(
      (item) => item.kind === "namespace" && item.exported === exportedName,
    );
    if (declaration?.kind !== "namespace") {
      return { matched: false };
    }
    const target = resolveModule(record.source, declaration.moduleSpecifier);
    if (target === undefined) {
      return { matched: true };
    }
    const key = `namespace:${record.source.fileId}#${exportedName}:${declaration.span.start.offset}`;
    namespaceTargets.set(key, {
      moduleSpecifier: declaration.moduleSpecifier,
      target,
    });
    return {
      matched: true,
      symbol: Object.freeze({
        key,
        kind: "namespace",
        name: exportedName,
        moduleSpecifier: record.source.fileId,
        source: record.source,
        generic: false,
      }),
    };
  }

  function resolveNamedExport(
    record: ModuleRecord,
    exportedName: string,
    visited: Set<string>,
  ): NamedExportResolution {
    const local = resolveLocalNamedExport(record, exportedName, visited);
    if (local.matched) {
      return local;
    }
    const reexported = resolveReexportedName(record, exportedName, visited);
    return reexported.matched ? reexported : resolveNamespaceExport(record, exportedName);
  }

  function resolveStarExports(
    record: ModuleRecord,
    exportedName: string,
    visited: Set<string>,
  ): readonly LinkedSymbol[] {
    if (exportedName === "default") {
      return [];
    }
    const candidates: LinkedSymbol[] = [];
    for (const declaration of record.source.unit.exports) {
      if (declaration.kind !== "reexport-all") {
        continue;
      }
      const target = resolveModule(record.source, declaration.moduleSpecifier);
      if (target === undefined) {
        continue;
      }
      const candidate = resolveModuleExport(
        target,
        declaration.moduleSpecifier,
        exportedName,
        new Set(visited),
      );
      if (candidate !== undefined && !candidates.some((item) => item.key === candidate.key)) {
        candidates.push(candidate);
      }
    }
    return candidates;
  }

  function resolveExport(
    record: ModuleRecord,
    exportedName: string,
    visited: Set<string>,
  ): LinkedSymbol | undefined {
    const visitKey = `${record.source.fileId}\0${exportedName}`;
    if (visited.has(visitKey)) {
      return undefined;
    }
    visited.add(visitKey);

    const direct = directlyExportedLocal(record, exportedName);
    if (direct !== undefined) {
      return direct;
    }
    const named = resolveNamedExport(record, exportedName, visited);
    if (named.matched) {
      return named.symbol;
    }
    const starCandidates = resolveStarExports(record, exportedName, visited);
    if (starCandidates.length > 1) {
      diagnostics.push(
        diagnostic({
          code: "AMBIGUOUS_RE_EXPORT",
          message: `${exportedName} is provided by multiple star exports in ${record.source.fileId}.`,
          related: starCandidates.map((candidate) => ({
            message: candidate.key,
          })),
          help: "Add an explicit named export for the intended symbol.",
        }),
      );
      return undefined;
    }
    return starCandidates.at(0);
  }

  function externalSymbol(
    moduleSpecifier: string,
    imported: string,
    physicalPath: string,
  ): LinkedSymbol | undefined {
    const directExport = externalDeclarations.get(physicalPath)?.get(imported);
    if (directExport === undefined) {
      return undefined;
    }
    return Object.freeze({
      key: `external:${physicalPath}#${imported}`,
      kind: directExport.kind,
      name: imported,
      moduleSpecifier,
      generic: directExport.generic,
    });
  }

  function contextSymbol(name: string): LinkedSymbol {
    return Object.freeze({
      key: `context:${name}`,
      kind: "context",
      name,
      moduleSpecifier: contextModuleSpecifier,
      generic: name === "Lazy",
    });
  }

  function resolveImport(
    record: ModuleRecord,
    reference: ImportReference,
    importedName: string,
    visited = new Set<string>(),
  ): LinkedSymbol | undefined {
    if (reference.moduleSpecifier === contextModuleSpecifier) {
      return contextSymbol(importedName);
    }
    const target = resolveModule(record.source, reference.moduleSpecifier);
    if (target === undefined) {
      return undefined;
    }
    return target.record === undefined
      ? externalSymbol(reference.moduleSpecifier, importedName, target.physicalPath)
      : resolveExport(target.record, importedName, visited);
  }

  function resolveLocal(
    record: ModuleRecord,
    name: string,
    visited = new Set<string>(),
  ): LinkedSymbol | undefined {
    const local = record.localSymbols.get(name);
    if (local !== undefined) {
      return local;
    }
    const imported = record.imports.get(name);
    return imported === undefined
      ? undefined
      : resolveImport(record, imported, imported.imported, visited);
  }

  function recordFor(source: ParsedSource): ModuleRecord {
    const record = recordsByFileId.get(source.fileId);
    if (record === undefined) {
      throw new Error(`Missing linker module ${source.fileId}`);
    }
    return record;
  }

  function resolveEntity(source: ParsedSource, entity: EntityName): LinkedSymbol | undefined {
    const record = recordFor(source);
    if (entity.kind === "identifier") {
      return resolveLocal(record, entity.name);
    }
    if (entity.left.kind === "identifier") {
      const namespace = record.imports.get(entity.left.name);
      if (namespace?.namespace === true) {
        return resolveImport(record, namespace, entity.right);
      }
    }
    const namespace = resolveEntity(source, entity.left);
    if (namespace?.kind !== "namespace") {
      return undefined;
    }
    const target = namespaceTargets.get(namespace.key);
    return target === undefined
      ? undefined
      : resolveModuleExport(target.target, target.moduleSpecifier, entity.right, new Set());
  }

  function resolveLazyType(
    source: ParsedSource,
    type: Extract<TypeNode, { readonly kind: "reference" }>,
    outer: LinkedSymbol | undefined,
  ): { readonly matched: boolean; readonly type?: LinkedType } {
    if (outer?.kind !== "context" || outer.name !== "Lazy" || type.typeArguments.length !== 1) {
      return { matched: false };
    }
    const inner = type.typeArguments[0];
    if (inner?.kind !== "reference") {
      return { matched: true };
    }
    const symbol = resolveEntity(source, inner.name);
    return symbol === undefined
      ? { matched: true }
      : {
          matched: true,
          type: {
            symbol,
            typeArguments: inner.typeArguments,
            lazy: true,
            span: type.span,
          },
        };
  }

  function resolveQualifiedType(
    source: ParsedSource,
    type: Extract<TypeNode, { readonly kind: "reference" }>,
  ): LinkedType | undefined {
    if (type.name.kind !== "qualified") {
      return undefined;
    }
    const symbol = resolveEntity(source, type.name.left);
    return symbol?.kind === "interface"
      ? {
          symbol,
          typeArguments: type.typeArguments,
          lazy: false,
          qualifierMember: type.name.right,
          span: type.span,
        }
      : undefined;
  }

  function resolveType(source: ParsedSource, type: TypeNode): LinkedType | undefined {
    if (type.kind !== "reference") {
      return undefined;
    }
    const outer = resolveEntity(source, type.name);
    const lazy = resolveLazyType(source, type, outer);
    if (lazy.matched) {
      return lazy.type;
    }
    if (outer !== undefined) {
      return {
        symbol: outer,
        typeArguments: type.typeArguments,
        lazy: false,
        span: type.span,
      };
    }
    const qualified = resolveQualifiedType(source, type);
    if (qualified !== undefined) {
      return qualified;
    }
    diagnostics.push(
      diagnostic({
        code: "TYPE_LINK_FAILED",
        message: `Cannot link type ${entityText(type.name)} in ${source.fileId}.`,
        help: "Use a directly exported non-generic class or interface.",
      }),
    );
    return undefined;
  }

  function symbolForDeclaration(
    source: ParsedSource,
    declaration: ClassDeclaration | InterfaceDeclaration,
  ): LinkedSymbol | undefined {
    const name = declaration.name;
    return name === undefined ? undefined : recordFor(source).localSymbols.get(name);
  }

  return {
    // diagnostics must stay the live array: resolveType/resolveExport keep pushing diagnostics
    // while analysis runs, and analysis reads linker.diagnostics only after it finishes — a
    // snapshot here would silently drop those late diagnostics.
    get diagnostics() {
      return diagnostics;
    },
    // Same timing constraint: the closures above keep resolving modules while analysis runs — a
    // re-export of the context specifier is resolved there for the first time, because
    // loadExternalDeclarations skips it — so this must be called after analysis finishes, never
    // snapshotted before it (Issue #26). Each call re-classifies every resolver dependency, which
    // is why compile() calls it exactly once.
    collectWatchInputs() {
      return createWatchInputs(collectWatchDependencies());
    },
    resolveEntity,
    resolveType,
    symbolForDeclaration,
  };
}
