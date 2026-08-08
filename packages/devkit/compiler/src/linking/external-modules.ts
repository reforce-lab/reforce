import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { toPortablePath } from "@reforce/primitives";
import type { LRUCache } from "lru-cache";
import type { ExternalSymbolAttribution, LinkedSymbol } from "@/linking/model";
import type { ImportReference, ModuleRecord, ModuleResolver } from "@/linking/module-resolver";
import type { PackageLocator } from "@/linking/package-locator";
import { parseSource } from "@/parser/parse-source";
import type {
  ClassDeclaration,
  InterfaceDeclaration,
  SourceFileIr,
  UnsupportedNamedDeclaration,
} from "@/parser/source-ir";
import { sourceKindOf } from "@/parser/source-kind";
import type { CanonicalFileId } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

// 外部（npm 包）模块进入与应用源同一套 ESM 绑定：闭包加载把 import/re-export 可达的外部声明
// 文件都建成 ModuleRecord，多级 re-export、重命名、star 歧义全部复用 export-binding 的既有算法
// （ADR 0004 决策 7「沿 re-export 链追到定义文件」，#120；旧实现只读直接导出，见 #145）。
// 符号 key 是包视角坐标：有 meta 户口表的按表归一，无表的退化为文件身份，包根作锚（决策 10）。

export interface StarterSymbolAnchor {
  readonly id: string;
  readonly subpath: string;
}

export interface StarterSymbolTable {
  anchorEntry(rootPath: string, file: string, exportName: string): StarterSymbolAnchor | undefined;
}

export interface ExternalModuleStore {
  load(seeds: readonly string[]): Promise<void>;
  recordAt(physicalPath: string): ModuleRecord | undefined;
}

interface ExternalModuleStoreInputs {
  readonly records: Map<string, ModuleRecord>;
  readonly cache: LRUCache<string, SourceFileIr>;
  readonly resolveModule: ModuleResolver;
  readonly locatePackage: PackageLocator;
  readonly symbolTable: StarterSymbolTable;
  readonly skipSpecifier: (specifier: string) => boolean;
}

function parserFileId(physicalPath: string): CanonicalFileId {
  const digest = createHash("sha256").update(physicalPath, "utf8").digest("hex");
  return `external/${digest}.ts` as CanonicalFileId; // The fixed prefix and hex digest satisfy the canonical relative path grammar.
}

export function subpathSpecifier(packageName: string, subpath: string): string {
  return subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`;
}

type NamedDeclaration = ClassDeclaration | InterfaceDeclaration | UnsupportedNamedDeclaration;

function directExportName(declaration: NamedDeclaration): string | undefined {
  if (declaration.export.kind === "named") {
    return declaration.export.exportedName;
  }
  return declaration.export.kind === "default-only" ? "default" : declaration.name;
}

function declarationIdentity(declaration: NamedDeclaration): string {
  const name = declaration.name ?? String(declaration.span.start.offset);
  return `${declaration.kind}:${name}`;
}

type ExportIdentityRegister = (exportedName: string, identity: string) => void;

function registerDeclarationExports(
  unit: SourceFileIr,
  locals: Map<string, NamedDeclaration>,
  register: ExportIdentityRegister,
): void {
  for (const declaration of [
    ...unit.interfaces,
    ...unit.classes,
    ...unit.unsupportedDeclarations,
  ]) {
    if (declaration.name !== undefined) {
      locals.set(declaration.name, declaration);
    }
    if (declaration.export.kind === "none") {
      continue;
    }
    const exportedName = directExportName(declaration);
    if (exportedName !== undefined) {
      register(exportedName, declarationIdentity(declaration));
    }
  }
}

function registerSpecifierExports(
  unit: SourceFileIr,
  locals: ReadonlyMap<string, NamedDeclaration>,
  register: ExportIdentityRegister,
): void {
  for (const declaration of unit.exports) {
    if (declaration.kind === "local-named") {
      for (const specifier of declaration.specifiers) {
        const local = locals.get(specifier.local);
        if (local !== undefined) {
          register(specifier.exported, declarationIdentity(local));
        }
      }
    }
    if (declaration.kind === "default-local") {
      const local = locals.get(declaration.local);
      if (local !== undefined) {
        register("default", declarationIdentity(local));
      }
    }
  }
}

// 与旧 directExports 同口径的重复导出检测：一个导出名指向多个不同声明时，该名字不可解析
// （非法 ESM 输入，静默取第一个会把坏包变成隐形错链）。
function ambiguousExportNames(unit: SourceFileIr): ReadonlySet<string> {
  const identities = new Map<string, Set<string>>();
  const locals = new Map<string, NamedDeclaration>();
  const register: ExportIdentityRegister = (exportedName, identity) => {
    const existing = identities.get(exportedName) ?? new Set<string>();
    existing.add(identity);
    identities.set(exportedName, existing);
  };
  registerDeclarationExports(unit, locals, register);
  registerSpecifierExports(unit, locals, register);
  return new Set(
    [...identities].flatMap(([exportedName, byIdentity]) =>
      byIdentity.size > 1 ? [exportedName] : [],
    ),
  );
}

function externalSymbolFor(
  declaration: ClassDeclaration | InterfaceDeclaration,
  source: ParsedSource,
  physicalPath: string,
  attribution: ExternalSymbolAttributionInputs | undefined,
): LinkedSymbol | undefined {
  const name = declaration.name;
  if (name === undefined) {
    return undefined;
  }
  if (attribution === undefined) {
    return Object.freeze({
      key: `${source.fileId}#${declaration.kind}:${name}`,
      kind: declaration.kind,
      name,
      moduleSpecifier: source.fileId,
      declaringSource: source,
      declaration,
      generic: declaration.generic,
    });
  }
  const exportName = directExportName(declaration) ?? name;
  const relative = toPortablePath(path.relative(attribution.rootPath, physicalPath));
  const anchor = attribution.anchorEntry(attribution.rootPath, relative, exportName);
  const external: ExternalSymbolAttribution = {
    packageName: attribution.packageName,
    version: attribution.version,
    packageRoot: attribution.rootPath,
    coordinate: anchor?.id ?? `${attribution.packageName}:${relative}#${exportName}`,
    metaSubpath: anchor?.subpath,
  };
  const moduleSpecifier =
    anchor === undefined
      ? attribution.packageName
      : subpathSpecifier(attribution.packageName, anchor.subpath);
  return Object.freeze({
    key:
      anchor === undefined
        ? `package:${attribution.rootPath}:${relative}#${exportName}`
        : `starter:${attribution.rootPath}#${anchor.id}`,
    kind: declaration.kind,
    name,
    moduleSpecifier,
    declaringSource: source,
    declaration,
    generic: declaration.generic,
    external,
  });
}

interface ExternalSymbolAttributionInputs {
  readonly packageName: string;
  readonly version: string;
  readonly rootPath: string;
  anchorEntry(rootPath: string, file: string, exportName: string): StarterSymbolAnchor | undefined;
}

function externalLocalSymbols(
  source: ParsedSource,
  physicalPath: string,
  attribution: ExternalSymbolAttributionInputs | undefined,
): ReadonlyMap<string, LinkedSymbol> {
  const localSymbols = new Map<string, LinkedSymbol>();
  for (const declaration of [...source.unit.interfaces, ...source.unit.classes]) {
    const symbol = externalSymbolFor(declaration, source, physicalPath, attribution);
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
          generic: declaration.generic,
        }),
      );
    }
  }
  return localSymbols;
}

function importReferencesFor(source: ParsedSource): ModuleRecord["imports"] {
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

export function referencedModuleSpecifiers(unit: SourceFileIr): readonly string[] {
  const specifiers = new Set<string>();
  for (const declaration of unit.imports) {
    if (declaration.kind === "import") {
      specifiers.add(declaration.moduleSpecifier);
    }
  }
  for (const declaration of unit.exports) {
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

export function createExternalModuleStore(inputs: ExternalModuleStoreInputs): ExternalModuleStore {
  const { records, cache, resolveModule, locatePackage, symbolTable, skipSpecifier } = inputs;
  const visited = new Set<string>();

  async function parseExternalSource(physicalPath: string): Promise<ParsedSource | undefined> {
    const sourceKind = sourceKindOf(physicalPath);
    if (sourceKind === undefined) {
      return undefined;
    }
    let sourceText: string;
    try {
      sourceText = await readFile(physicalPath, "utf8");
    } catch {
      return undefined;
    }
    const fileId = parserFileId(physicalPath);
    const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");
    const cacheKey = JSON.stringify([fileId, sourceKind, sourceHash]);
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return { absolutePath: physicalPath, fileId, sourceKind, unit: cached };
    }
    const parsed = parseSource({ file: fileId, sourceKind, sourceText });
    if (parsed.status === "failure") {
      return undefined;
    }
    cache.set(cacheKey, parsed.unit);
    return { absolutePath: physicalPath, fileId, sourceKind, unit: parsed.unit };
  }

  async function loadOne(physicalPath: string): Promise<readonly string[]> {
    const source = await parseExternalSource(physicalPath);
    if (source === undefined) {
      return [];
    }
    const location = locatePackage(physicalPath);
    const attribution: ExternalSymbolAttributionInputs | undefined =
      location === undefined
        ? undefined
        : {
            packageName: location.packageName,
            version: location.version,
            rootPath: location.rootPath,
            anchorEntry: (rootPath, file, exportName) =>
              symbolTable.anchorEntry(rootPath, file, exportName),
          };
    records.set(physicalPath, {
      source,
      localSymbols: externalLocalSymbols(source, physicalPath, attribution),
      imports: importReferencesFor(source),
      ambiguousExports: ambiguousExportNames(source.unit),
    });
    const next: string[] = [];
    for (const specifier of referencedModuleSpecifiers(source.unit)) {
      if (skipSpecifier(specifier)) {
        continue;
      }
      const target = resolveModule(source, specifier, false);
      if (
        target !== undefined &&
        target.record === undefined &&
        !visited.has(target.physicalPath)
      ) {
        next.push(target.physicalPath);
      }
    }
    return next;
  }

  async function load(seeds: readonly string[]): Promise<void> {
    const queue = [...seeds];
    while (queue.length > 0) {
      const physicalPath = queue.shift();
      if (physicalPath === undefined || visited.has(physicalPath) || records.has(physicalPath)) {
        continue;
      }
      visited.add(physicalPath);
      queue.push(...(await loadOne(physicalPath)));
    }
  }

  return {
    load,
    recordAt(physicalPath) {
      return records.get(physicalPath);
    },
  };
}
