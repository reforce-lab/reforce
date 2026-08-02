import { createHash } from "node:crypto";
import * as nodeFileSystem from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  CanonicalFileId,
  ClassDeclaration,
  CompilerFrontend,
  EntityName,
  InterfaceDeclaration,
  SourceSpan,
  SourceUnit,
  TypeNode,
} from "@reforce/compiler-spi";
import enhancedResolve from "enhanced-resolve";
import type { LRUCache } from "lru-cache";
import { compareUtf16CodeUnits } from "../determinism";
import { diagnostic } from "../diagnostics";
import type { CachedParse } from "../incremental/parse-cache";
import { frontendSourceKind, type ParsedSource } from "../project/source-files";
import type { CompilerDiagnostic, ResolvedApplicationProject } from "../types";

export type LinkedSymbolKind = "class" | "interface" | "context" | "namespace" | "unsupported";

export interface LinkedSymbol {
  readonly key: string;
  readonly kind: LinkedSymbolKind;
  readonly name: string;
  readonly moduleSpecifier: string;
  readonly source?: ParsedSource;
  readonly declaration?: ClassDeclaration | InterfaceDeclaration;
  readonly generic: boolean;
}

export interface LinkedType {
  readonly symbol: LinkedSymbol;
  readonly typeArguments: readonly TypeNode[];
  readonly lazy: boolean;
  readonly qualifierMember?: string;
  readonly span: SourceSpan;
}

interface ImportReference {
  readonly moduleSpecifier: string;
  readonly imported: string;
  readonly namespace: boolean;
}

interface ModuleRecord {
  readonly source: ParsedSource;
  readonly localSymbols: ReadonlyMap<string, LinkedSymbol>;
  readonly imports: ReadonlyMap<string, ImportReference>;
}

interface ResolvedModule {
  readonly physicalPath: string;
  readonly record?: ModuleRecord;
}

export interface Linker {
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly fileDependencies: readonly string[];
  readonly contextDependencies: readonly string[];
  readonly missingDependencies: readonly string[];
  resolveEntity(source: ParsedSource, entity: EntityName): LinkedSymbol | undefined;
  resolveType(source: ParsedSource, type: TypeNode): LinkedType | undefined;
  symbolForDeclaration(
    source: ParsedSource,
    declaration: ClassDeclaration | InterfaceDeclaration,
  ): LinkedSymbol | undefined;
}

function entityText(entity: EntityName): string {
  return entity.kind === "identifier"
    ? entity.name.text
    : `${entityText(entity.left)}.${entity.right.text}`;
}

function moduleKey(file: string): string {
  try {
    return nodeFileSystem.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function createLocalSymbol(
  source: ParsedSource,
  declaration: ClassDeclaration | InterfaceDeclaration,
): LinkedSymbol | undefined {
  const name = declaration.name?.text;
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
    generic: declaration.typeParameters.length > 0,
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
    const name = declaration.name?.text;
    if (name !== undefined) {
      localSymbols.set(
        name,
        Object.freeze({
          key: `${source.fileId}#unsupported:${name}`,
          kind: "unsupported",
          name,
          moduleSpecifier: source.fileId,
          source,
          generic: declaration.typeParameters.length > 0,
        }),
      );
    }
  }
  return localSymbols;
}

function importReferencesFor(source: ParsedSource): ReadonlyMap<string, ImportReference> {
  const imports = new Map<string, ImportReference>();
  for (const declaration of source.unit.imports) {
    if (declaration.kind !== "import") {
      continue;
    }
    for (const binding of declaration.bindings) {
      if (binding.kind === "default") {
        imports.set(binding.local.text, {
          moduleSpecifier: declaration.moduleSpecifier.text,
          imported: "default",
          namespace: false,
        });
        continue;
      }
      if (binding.kind === "namespace") {
        imports.set(binding.local.text, {
          moduleSpecifier: declaration.moduleSpecifier.text,
          imported: "*",
          namespace: true,
        });
        continue;
      }
      imports.set(binding.local.text, {
        moduleSpecifier: declaration.moduleSpecifier.text,
        imported: binding.imported.text,
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

interface ExternalExport {
  readonly kind: "class" | "interface";
  readonly generic: boolean;
}

interface ExternalExportCandidate extends ExternalExport {
  readonly identity: string;
}

function addExternalExportCandidate(
  candidates: Map<string, Map<string, ExternalExportCandidate>>,
  exportedName: string,
  candidate: ExternalExportCandidate,
): void {
  const byIdentity = candidates.get(exportedName) ?? new Map<string, ExternalExportCandidate>();
  const existing = byIdentity.get(candidate.identity);
  byIdentity.set(candidate.identity, {
    identity: candidate.identity,
    kind: candidate.kind,
    generic: existing?.generic === true || candidate.generic,
  });
  candidates.set(exportedName, byIdentity);
}

function declarationExportName(
  declaration: ClassDeclaration | InterfaceDeclaration,
): string | undefined {
  if (declaration.export.kind === "named") {
    return declaration.export.exportedName.text;
  }
  return declaration.export.kind === "default-only" ? "default" : undefined;
}

function collectExternalDeclarations(
  unit: SourceUnit,
  candidates: Map<string, Map<string, ExternalExportCandidate>>,
): ReadonlyMap<string, ExternalExportCandidate> {
  const locals = new Map<string, ExternalExportCandidate>();
  for (const declaration of [...unit.interfaces, ...unit.classes]) {
    const name = declaration.name?.text;
    const generic = declaration.typeParameters.length > 0;
    const identity =
      name === undefined
        ? `${declaration.kind}:${declaration.span.start.offset}`
        : `${declaration.kind}:${name}`;
    const candidate = { identity, kind: declaration.kind, generic };
    if (name !== undefined) {
      const existing = locals.get(name);
      locals.set(name, {
        identity,
        kind: declaration.kind,
        generic: existing?.generic === true || generic,
      });
    }
    const exportedName = declarationExportName(declaration);
    if (exportedName !== undefined) {
      addExternalExportCandidate(candidates, exportedName, candidate);
    }
  }
  return locals;
}

function localExportCandidates(
  declaration: SourceUnit["exports"][number],
  locals: ReadonlyMap<string, ExternalExportCandidate>,
): readonly (readonly [string, ExternalExportCandidate])[] {
  if (declaration.kind === "local-named") {
    return declaration.specifiers.flatMap((specifier) => {
      const local = locals.get(specifier.local.text);
      return local === undefined ? [] : [[specifier.exported.text, local] as const];
    });
  }
  if (declaration.kind !== "default-local") {
    return [];
  }
  const local = locals.get(declaration.local.text);
  return local === undefined ? [] : [["default", local] as const];
}

function directExternalExports(unit: SourceUnit): ReadonlyMap<string, ExternalExport> {
  const candidates = new Map<string, Map<string, ExternalExportCandidate>>();
  const locals = collectExternalDeclarations(unit, candidates);
  for (const declaration of unit.exports) {
    for (const [exportedName, candidate] of localExportCandidates(declaration, locals)) {
      addExternalExportCandidate(candidates, exportedName, candidate);
    }
  }
  return new Map(
    [...candidates].flatMap(([exportedName, byIdentity]) => {
      const candidate = byIdentity.size === 1 ? [...byIdentity.values()][0] : undefined;
      return candidate === undefined
        ? []
        : [[exportedName, { kind: candidate.kind, generic: candidate.generic }] as const];
    }),
  );
}

function externalParserFileId(physicalPath: string): CanonicalFileId {
  const digest = createHash("sha256").update(physicalPath, "utf8").digest("hex");
  return `external/${digest}.ts` as CanonicalFileId; // The fixed prefix and hex digest satisfy the canonical relative path grammar.
}

async function readExternalExports(
  physicalPath: string,
  frontend: CompilerFrontend,
  cache: LRUCache<string, CachedParse>,
): Promise<ReadonlyMap<string, ExternalExport> | undefined> {
  const sourceKind = frontendSourceKind(physicalPath);
  if (sourceKind === undefined) {
    return undefined;
  }
  let sourceText: string;
  try {
    sourceText = await readFile(physicalPath, "utf8");
  } catch {
    return undefined;
  }
  const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");
  const cacheKey = JSON.stringify([
    "external-declaration",
    physicalPath,
    sourceHash,
    frontend.cacheKey,
    sourceKind,
  ]);
  const cached = cache.get(cacheKey);
  const parsed =
    cached === undefined
      ? await frontend.parse({
          file: externalParserFileId(physicalPath),
          sourceKind,
          sourceText,
        })
      : { unit: cached.unit, diagnostics: [] };
  if (parsed.unit === undefined || parsed.diagnostics.length > 0) {
    return undefined;
  }
  if (cached === undefined) {
    cache.set(cacheKey, { unit: parsed.unit });
  }
  return directExternalExports(parsed.unit);
}

function referencedModuleSpecifiers(source: ParsedSource): readonly string[] {
  const specifiers = new Set<string>();
  for (const declaration of source.unit.imports) {
    if (declaration.kind === "import") {
      specifiers.add(declaration.moduleSpecifier.text);
    }
  }
  for (const declaration of source.unit.exports) {
    if (
      declaration.kind === "reexport-named" ||
      declaration.kind === "reexport-all" ||
      declaration.kind === "namespace"
    ) {
      specifiers.add(declaration.moduleSpecifier.text);
    }
  }
  return [...specifiers];
}

type ModuleResolver = (
  source: ParsedSource,
  specifier: string,
  reportFailure?: boolean,
) => ResolvedModule | undefined;

async function loadExternalExports(
  sources: readonly ParsedSource[],
  resolveModule: ModuleResolver,
  frontend: CompilerFrontend,
  cache: LRUCache<string, CachedParse>,
): Promise<ReadonlyMap<string, ReadonlyMap<string, ExternalExport> | undefined>> {
  const externalPaths = new Set<string>();
  for (const source of sources) {
    for (const specifier of referencedModuleSpecifiers(source)) {
      const target =
        specifier === "@reforce/context" ? undefined : resolveModule(source, specifier, false);
      if (target !== undefined && target.record === undefined) {
        externalPaths.add(target.physicalPath);
      }
    }
  }
  const result = new Map<string, ReadonlyMap<string, ExternalExport> | undefined>();
  for (const physicalPath of [...externalPaths].sort(compareUtf16CodeUnits)) {
    result.set(physicalPath, await readExternalExports(physicalPath, frontend, cache));
  }
  return result;
}

function classifyResolverDependencies(
  resolverDependencies: ReadonlySet<string>,
  fileDependencies: Set<string>,
  contextDependencies: Set<string>,
  missingDependencies: Set<string>,
): void {
  for (const dependency of resolverDependencies) {
    try {
      const target = nodeFileSystem.statSync(dependency).isDirectory()
        ? contextDependencies
        : fileDependencies;
      target.add(dependency);
    } catch {
      missingDependencies.add(dependency);
    }
  }
}

export async function createLinker(
  sources: readonly ParsedSource[],
  project: ResolvedApplicationProject,
  frontend: CompilerFrontend,
  cache: LRUCache<string, CachedParse>,
  customConditions: readonly string[] = [],
): Promise<Linker> {
  const records = new Map<string, ModuleRecord>();
  const recordsByFileId = new Map<string, ModuleRecord>();
  const diagnostics: CompilerDiagnostic[] = [];
  const fileDependencies = new Set<string>();
  const contextDependencies = new Set<string>();
  const missingDependencies = new Set<string>();
  const resolverFileDependencies = new Set<string>();
  for (const source of sources) {
    const record = createModuleRecord(source);
    records.set(moduleKey(source.absolutePath), record);
    recordsByFileId.set(source.fileId, record);
  }
  const resolverOptions = {
    descriptionFiles: ["package.json"],
    exportsFields: ["exports"],
    importsFields: ["imports"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".d.mts", ".d.cts", ".js", ".mjs", ".cjs"],
    extensionAlias: {
      ".js": [".ts", ".tsx", ".d.ts", ".js"],
      ".mjs": [".mts", ".d.mts", ".mjs"],
      ".cjs": [".cts", ".d.cts", ".cjs"],
    },
    extensionAliasForExports: true,
    fileSystem: nodeFileSystem,
    mainFields: ["types", "typings", "module", "main"],
    symlinks: true,
    tsconfig: project.tsconfigPath,
    useSyncFileSystemCalls: true,
  };
  const resolveImportTypeModule = enhancedResolve.create.sync({
    ...resolverOptions,
    conditionNames: ["types", ...customConditions, "import", "default"],
  });
  const resolveRequireTypeModule = enhancedResolve.create.sync({
    ...resolverOptions,
    conditionNames: ["types", ...customConditions, "require", "default"],
  });

  const resolutionContext = {
    fileDependencies: resolverFileDependencies,
    contextDependencies,
    missingDependencies,
  };
  const resolvedModules = new Map<string, ResolvedModule | false>();
  const reportedFailures = new Set<string>();

  function resolutionKey(containing: ParsedSource, specifier: string): string {
    return `${containing.absolutePath}\0${specifier}`;
  }

  function resolveUncachedModule(
    containing: ParsedSource,
    specifier: string,
  ): ResolvedModule | false {
    let resolved: string | false;
    try {
      const resolveTypeModule = ["cts", "d.cts"].includes(containing.sourceKind)
        ? resolveRequireTypeModule
        : resolveImportTypeModule;
      resolved = resolveTypeModule(
        path.dirname(containing.absolutePath),
        specifier,
        resolutionContext,
      );
    } catch {
      resolved = false;
    }
    if (resolved === false) {
      return false;
    }
    resolverFileDependencies.add(resolved);
    const physicalPath = moduleKey(resolved);
    const record = records.get(physicalPath);
    return record === undefined ? { physicalPath } : { physicalPath, record };
  }

  function resolveModule(
    containing: ParsedSource,
    specifier: string,
    reportFailure = true,
  ): ResolvedModule | undefined {
    const key = resolutionKey(containing, specifier);
    let result = resolvedModules.get(key);
    if (result === undefined) {
      result = resolveUncachedModule(containing, specifier);
      resolvedModules.set(key, result);
    }
    if (result === false) {
      if (!reportFailure || reportedFailures.has(key)) {
        return undefined;
      }
      reportedFailures.add(key);
      diagnostics.push(
        diagnostic({
          code: "MODULE_RESOLUTION_FAILED",
          message: `Cannot resolve ${specifier} from ${containing.fileId}.`,
          help: "Fix the import, package exports, paths, or moduleResolution configuration.",
        }),
      );
      return undefined;
    }
    return result;
  }

  const externalExports = await loadExternalExports(sources, resolveModule, frontend, cache);
  classifyResolverDependencies(
    resolverFileDependencies,
    fileDependencies,
    contextDependencies,
    missingDependencies,
  );

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
      const specifier = declaration.specifiers.find((item) => item.exported.text === exportedName);
      if (specifier !== undefined) {
        const symbol = resolveLocal(record, specifier.local.text, visited);
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
      const specifier = declaration.specifiers.find((item) => item.exported.text === exportedName);
      if (specifier !== undefined) {
        const symbol = resolveExportFromModule(
          record,
          declaration.moduleSpecifier.text,
          specifier.local.text,
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
      (item) => item.kind === "namespace" && item.exported.text === exportedName,
    );
    if (declaration?.kind !== "namespace") {
      return { matched: false };
    }
    const target = resolveModule(record.source, declaration.moduleSpecifier.text);
    if (target === undefined) {
      return { matched: true };
    }
    const key = `namespace:${record.source.fileId}#${exportedName}:${declaration.span.start.offset}`;
    namespaceTargets.set(key, {
      moduleSpecifier: declaration.moduleSpecifier.text,
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
      const target = resolveModule(record.source, declaration.moduleSpecifier.text);
      if (target === undefined) {
        continue;
      }
      const candidate = resolveModuleExport(
        target,
        declaration.moduleSpecifier.text,
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

    const direct = record.localSymbols.get(exportedName);
    if (direct?.declaration?.export.kind === "named") {
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
    const directExport = externalExports.get(physicalPath)?.get(imported);
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
      moduleSpecifier: "@reforce/context",
      generic: name === "Lazy",
    });
  }

  function resolveImport(
    record: ModuleRecord,
    reference: ImportReference,
    importedName = reference.imported,
    visited = new Set<string>(),
  ): LinkedSymbol | undefined {
    if (reference.moduleSpecifier === "@reforce/context") {
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
      return resolveLocal(record, entity.name.text);
    }
    if (entity.left.kind === "identifier") {
      const namespace = record.imports.get(entity.left.name.text);
      if (namespace?.namespace === true) {
        return resolveImport(record, namespace, entity.right.text);
      }
    }
    const namespace = resolveEntity(source, entity.left);
    if (namespace?.kind !== "namespace") {
      return undefined;
    }
    const target = namespaceTargets.get(namespace.key);
    return target === undefined
      ? undefined
      : resolveModuleExport(target.target, target.moduleSpecifier, entity.right.text, new Set());
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
          qualifierMember: type.name.right.text,
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
    const name = declaration.name?.text;
    return name === undefined ? undefined : recordFor(source).localSymbols.get(name);
  }

  return {
    get diagnostics() {
      return diagnostics;
    },
    get fileDependencies() {
      return [...fileDependencies];
    },
    get contextDependencies() {
      return [...contextDependencies];
    },
    get missingDependencies() {
      return [...missingDependencies];
    },
    resolveEntity,
    resolveType,
    symbolForDeclaration,
  };
}
