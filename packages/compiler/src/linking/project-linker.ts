import { isBuiltin } from "node:module";
import { compareUtf16CodeUnits } from "@reforce/primitives";
import type { LRUCache } from "lru-cache";
import type { CompilerDiagnostic, CompilerWatchInputs, ResolvedApplicationProject } from "@/api";
import { diagnostic } from "@/diagnostics";
import {
  contextModuleSpecifier,
  createExportBinder,
  type ExternalDeclarationIndex,
} from "@/linking/export-binding";
import {
  type ExternalDeclaration,
  readExternalDeclarations,
} from "@/linking/external-declarations";
import type { LinkedSymbol, LinkedType } from "@/linking/model";
import { createModuleRecord } from "@/linking/module-record";
import {
  createModuleResolver,
  type ModuleRecord,
  type ModuleResolver,
  moduleKey,
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
): Promise<ExternalDeclarationIndex> {
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
  const binder = createExportBinder({ externalDeclarations, diagnostics, resolveModule });

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
