import { isBuiltin } from "node:module";
import { compareUtf16CodeUnits } from "@reforce/primitives";
import type { LRUCache } from "lru-cache";
import type { CompilerDiagnostic, CompilerWatchInputs, ResolvedApplicationProject } from "@/api";
import { diagnostic } from "@/diagnostics";
import { createExportBinder, isFrameworkSpecifier } from "@/linking/export-binding";
import { createExternalModuleStore, referencedModuleSpecifiers } from "@/linking/external-modules";
import type { LinkedSymbol, LinkedType } from "@/linking/model";
import { createModuleRecord } from "@/linking/module-record";
import { createModuleResolver, type ModuleRecord, moduleKey } from "@/linking/module-resolver";
import { createPackageLocator } from "@/linking/package-locator";
import {
  createStarterLinkage,
  emptyStarterLinkage,
  loadStarterRegistry,
  readStarterRegistrations,
  type StarterLinkage,
  starterSeedPaths,
} from "@/linking/starter-linking";
import type {
  ClassDeclaration,
  EntityName,
  InterfaceDeclaration,
  SourceFileIr,
  TypeNode,
} from "@/parser/source-ir";
import type { ParsedSource } from "@/project/source-files";
import { createWatchInputs } from "@/project/watch-inputs";

export interface ProjectLinker {
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly starterLinkage: StarterLinkage;
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
  const { resolveModule, resolveFromDirectory, collectWatchDependencies } = createModuleResolver(
    records,
    diagnostics,
    project,
    customConditions,
  );
  const locatePackage = createPackageLocator();
  // binder 的每次查询都现读 records，因此可以在外部闭包装载前创建：注册读取只会命中应用记录
  // 与 @reforce/context 特例，装载后同一实例自动看见外部记录。
  const binder = createExportBinder({ diagnostics, resolveModule });

  function recordFor(source: ParsedSource): ModuleRecord {
    const record = recordsByFileId.get(source.fileId);
    if (record === undefined) {
      throw new Error(`Missing linker module ${source.fileId}`);
    }
    return record;
  }

  const registrations = readStarterRegistrations(
    sources,
    recordFor,
    (record, callee) =>
      callee.kind === "identifier" ? binder.resolveLocal(record, callee.name) : undefined,
    diagnostics,
  );
  const registry = await loadStarterRegistry({
    registrations,
    resolveFromDirectory,
    locatePackage,
    diagnostics,
  });

  const externalStore = createExternalModuleStore({
    records,
    cache,
    resolveModule,
    locatePackage,
    symbolTable: registry,
    skipSpecifier: (specifier) => isFrameworkSpecifier(specifier) || isBuiltin(specifier),
  });
  const seeds = new Set<string>();
  for (const source of sources) {
    for (const specifier of referencedModuleSpecifiers(source.unit)) {
      const target =
        isFrameworkSpecifier(specifier) || isBuiltin(specifier)
          ? undefined
          : resolveModule(source, specifier, false);
      if (target !== undefined && target.record === undefined) {
        seeds.add(target.physicalPath);
      }
    }
  }
  for (const seed of starterSeedPaths(
    registry,
    resolveFromDirectory,
    locatePackage,
    resolveModule,
  )) {
    seeds.add(seed);
  }
  await externalStore.load([...seeds].sort(compareUtf16CodeUnits));

  const starterLinkage =
    registry.starters.length === 0
      ? emptyStarterLinkage
      : createStarterLinkage({
          registry,
          projectRoot: project.projectRoot,
          diagnostics,
          resolveFromDirectory,
          locatePackage,
          recordAt: (physicalPath) => records.get(physicalPath),
          resolveModule,
          resolveModuleExportFor: binder.resolveModuleExportFor,
        });

  function resolveEntity(source: ParsedSource, entity: EntityName): LinkedSymbol | undefined {
    const record = recordFor(source);
    if (entity.kind === "identifier") {
      return binder.resolveLocal(record, entity.name);
    }
    if (entity.left.kind === "identifier") {
      const namespace = record.imports.get(entity.left.name);
      if (namespace?.namespace === true) {
        return binder.resolveImport(record, namespace, entity.right);
      }
    }
    const namespace = resolveEntity(source, entity.left);
    if (namespace?.kind !== "namespace") {
      return undefined;
    }
    return binder.resolveNamespaceMember(namespace.key, entity.right);
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
    // diagnostics must stay the live array: resolveType and the export binder keep pushing
    // diagnostics while analysis runs, and analysis reads linker.diagnostics only after it
    // finishes — a snapshot here would silently drop those late diagnostics.
    get diagnostics() {
      return diagnostics;
    },
    starterLinkage,
    // Same timing constraint: the closures above keep resolving modules while analysis runs — a
    // re-export of the context specifier is resolved there for the first time, because
    // the external closure loader skips it — so this must be called after analysis finishes, never
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
