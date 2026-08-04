import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { LinkedSymbol } from "@/linking/model";
import type {
  ImportReference,
  ModuleRecord,
  ModuleResolver,
  ResolvedModule,
} from "@/linking/module-resolver";

// ESM 的导出绑定语义：给定「某个模块导出的某个名字」，找出它最终绑定到哪个符号。
// 覆盖 local-named、reexport-named、`export * as`、`export *` 的歧义与截断。外部（npm 包）文件
// 由 external-modules 的闭包加载建成同构 ModuleRecord 走同一算法（ADR 0004 决策 7，#120）；
// 没有记录的解析目标（js-only、解析失败）就是解析不出符号。依赖全部由 createExportBinder 注入，
// 因此这一层可以脱离真实文件系统单测（Issue #117）；上层的 project-linker 只消费结果，从不被
// 这里回调。

export const contextModuleSpecifier = "@reforce/context";
export const configModuleSpecifier = "@reforce/config";

// 框架自有包的 import 一律短路合成符号、不读真实文件（与 contextSymbol 同一策略）；表驱动
// 保持"specifier → 符号 kind/key 前缀"三处一致（Issue #114 的名单纪律）。
const frameworkSpecifierKinds = {
  [contextModuleSpecifier]: "context",
  [configModuleSpecifier]: "config",
} as const satisfies Record<string, "context" | "config">;

export function isFrameworkSpecifier(specifier: string): boolean {
  return Object.hasOwn(frameworkSpecifierKinds, specifier);
}

interface ExportBinderInputs {
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

function frameworkSymbol(
  specifier: keyof typeof frameworkSpecifierKinds,
  name: string,
): LinkedSymbol {
  const kind = frameworkSpecifierKinds[specifier];
  return Object.freeze({
    key: `${kind}:${name}`,
    kind,
    name,
    moduleSpecifier: specifier,
    generic: kind === "context" && name === "Lazy",
  });
}

export function createExportBinder({ diagnostics, resolveModule }: ExportBinderInputs) {
  const namespaceTargets = new Map<string, NamespaceTarget>();

  function resolveModuleExport(
    target: ResolvedModule,
    exportedName: string,
    visited: Set<string>,
  ): LinkedSymbol | undefined {
    return target.record === undefined
      ? undefined
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
    return resolveModuleExport(target, exportedName, visited);
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
      const candidate = resolveModuleExport(target, exportedName, new Set(visited));
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

    if (record.ambiguousExports?.has(exportedName) === true) {
      return undefined;
    }
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
    if (Object.hasOwn(frameworkSpecifierKinds, reference.moduleSpecifier)) {
      // Object.hasOwn 已证明成员资格，索引签名推不回字面量联合 // justified: 见上一行
      return frameworkSymbol(
        reference.moduleSpecifier as keyof typeof frameworkSpecifierKinds,
        importedName,
      );
    }
    const target = resolveModule(record.source, reference.moduleSpecifier);
    if (target === undefined) {
      return undefined;
    }
    return resolveModuleExport(target, importedName, visited);
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
      : resolveModuleExport(target.target, exportedName, new Set());
  }

  // starter 链接层（registry 交叉核对、契约坐标解析、根探测）需要对任意已解析模块按导出名取符号，
  // 与 re-export 链共用同一套算法；每次调用独立 visited，互不污染。
  function resolveModuleExportFor(
    target: ResolvedModule,
    exportedName: string,
  ): LinkedSymbol | undefined {
    return resolveModuleExport(target, exportedName, new Set());
  }

  return { resolveLocal, resolveImport, resolveModuleExportFor, resolveNamespaceMember };
}
