import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { ExternalDeclaration } from "@/linking/external-declarations";
import type { LinkedSymbol } from "@/linking/model";
import type {
  ImportReference,
  ModuleRecord,
  ModuleResolver,
  ResolvedModule,
} from "@/linking/module-resolver";

// ESM 的导出绑定语义：给定「某个模块导出的某个名字」，找出它最终绑定到哪个符号。
// 覆盖 local-named、reexport-named、`export * as`、`export *` 的歧义与截断、以及解析到项目外
// `.d.ts` 时的外部回退。依赖全部由 createExportBinder 注入，因此这一层可以脱离真实文件系统单测
// （Issue #117）；上层的 project-linker 只消费结果，从不被这里回调。

export const contextModuleSpecifier = "@reforce/context";

export type ExternalDeclarationIndex = ReadonlyMap<
  string,
  ReadonlyMap<string, ExternalDeclaration> | undefined
>;

interface ExportBinderInputs {
  readonly externalDeclarations: ExternalDeclarationIndex;
  readonly diagnostics: CompilerDiagnostic[];
  readonly resolveModule: ModuleResolver;
}

interface NamedExportResolution {
  readonly matched: boolean;
  readonly symbol?: LinkedSymbol;
}

interface NamespaceTarget {
  readonly moduleSpecifier: string;
  readonly target: ResolvedModule;
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

function contextSymbol(name: string): LinkedSymbol {
  return Object.freeze({
    key: `context:${name}`,
    kind: "context",
    name,
    moduleSpecifier: contextModuleSpecifier,
    generic: name === "Lazy",
  });
}

export function createExportBinder({
  externalDeclarations,
  diagnostics,
  resolveModule,
}: ExportBinderInputs) {
  const namespaceTargets = new Map<string, NamespaceTarget>();

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

  // `export * as ns from "..."` 产生的 namespace 符号只带一个 key，成员解析要靠这张表回到目标模块；
  // 表留在 binder 内部，上层拿到 namespace 符号后只能经此查成员。
  function resolveNamespaceMember(
    namespaceKey: string,
    exportedName: string,
  ): LinkedSymbol | undefined {
    const target = namespaceTargets.get(namespaceKey);
    return target === undefined
      ? undefined
      : resolveModuleExport(target.target, target.moduleSpecifier, exportedName, new Set());
  }

  return { resolveLocal, resolveImport, resolveNamespaceMember };
}
