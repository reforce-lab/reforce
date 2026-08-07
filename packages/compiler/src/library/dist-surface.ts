import { isBuiltin } from "node:module";
import { compareUtf16CodeUnits } from "@reforce/primitives";
import type { LRUCache } from "lru-cache";
import type { CompilerDiagnostic, ResolvedApplicationProject } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { LibraryPackageManifest } from "@/library/package-exports";
import {
  coreModuleSpecifier,
  createExportBinder,
  transactionModuleSpecifier,
} from "@/linking/export-binding";
import { createExternalModuleStore } from "@/linking/external-modules";
import type { LinkedSymbol } from "@/linking/model";
import { createModuleResolver, type ModuleRecord, moduleKey } from "@/linking/module-resolver";
import { createPackageLocator, type PackageLocator } from "@/linking/package-locator";
import { parseContractCoordinate } from "@/linking/starter-meta";
import type { SourceFileIr } from "@/parser/source-ir";

// 库模式的 dist 公开面（ADR 0004 决策 7/15，#120/#147）：对作者已构建的 dist d.ts 建与应用侧
// 完全同套的 ModuleRecord + ESM binder，沿 re-export 链把每个公开导出追到定义声明。锚点取
// （定义文件包内相对路径, 定义处导出名）——与消费侧 external-modules.externalSymbolFor 的
// anchorEntry 查询键逐字对齐，这正是"一边登记、一边查表"路线成立的前提。dist 面同时是决策 15
// 交叉核对的生产侧前移：bean 的 runtimeExport 从这里反推，形状不符在发布前就拦下。

export interface LibrarySurfaceLocation {
  readonly subpath: string;
  readonly exportedName: string;
}

export interface LibrarySurfaceSymbol {
  readonly id: string;
  readonly anchorFile: string;
  readonly anchorExportName: string;
  readonly symbol: LinkedSymbol;
  readonly subpaths: readonly string[];
  readonly locations: readonly LibrarySurfaceLocation[];
}

export interface LibrarySurface {
  readonly symbols: readonly LibrarySurfaceSymbol[];
  symbolById(id: string): LibrarySurfaceSymbol | undefined;
  resolveFromDirectory(directory: string, specifier: string): string | undefined;
  readonly locatePackage: PackageLocator;
  collectWatchDependencies(): {
    readonly fileDependencies: ReadonlySet<string>;
    readonly contextDependencies: ReadonlySet<string>;
    readonly missingDependencies: ReadonlySet<string>;
  };
}

interface LibrarySurfaceInputs {
  readonly project: ResolvedApplicationProject;
  readonly manifest: LibraryPackageManifest;
  readonly cache: LRUCache<string, SourceFileIr>;
  readonly customConditions: readonly string[];
  readonly diagnostics: CompilerDiagnostic[];
}

function directExportName(
  declaration:
    | SourceFileIr["classes"][number]
    | SourceFileIr["interfaces"][number]
    | SourceFileIr["unsupportedDeclarations"][number],
): string | undefined {
  if (declaration.export.kind === "none") {
    return undefined;
  }
  if (declaration.export.kind === "named") {
    return declaration.export.exportedName;
  }
  return declaration.export.kind === "default-only" ? "default" : declaration.name;
}

interface CollectedSymbol {
  readonly anchorFile: string;
  readonly anchorExportName: string;
  readonly symbol: LinkedSymbol;
  readonly locations: LibrarySurfaceLocation[];
}

export async function createLibrarySurface(inputs: LibrarySurfaceInputs): Promise<LibrarySurface> {
  const { project, manifest, cache, customConditions, diagnostics } = inputs;
  // dist 面的解析噪声（坏包内部的断链、与 DI 无关的 star 歧义）不进真实诊断流：应用侧的外部
  // 闭包加载同样静默吞掉它们，只有被 bean/契约实际需要的符号缺失才在 meta 构建处报错。
  const scratchDiagnostics: CompilerDiagnostic[] = [];
  const records = new Map<string, ModuleRecord>();
  const { resolveModule, resolveFromDirectory, collectWatchDependencies } = createModuleResolver(
    records,
    scratchDiagnostics,
    project,
    customConditions,
  );
  const locatePackage = createPackageLocator();
  const store = createExternalModuleStore({
    records,
    cache,
    resolveModule,
    locatePackage,
    symbolTable: { anchorEntry: () => undefined },
    skipSpecifier: (specifier) =>
      specifier === coreModuleSpecifier ||
      specifier === transactionModuleSpecifier ||
      isBuiltin(specifier),
  });
  await store.load(manifest.subpaths.map((entry) => moduleKey(entry.typesFile)));
  const binder = createExportBinder({ diagnostics: scratchDiagnostics, resolveModule });

  function declaredExportNames(unit: SourceFileIr): readonly string[] {
    return [...unit.interfaces, ...unit.classes, ...unit.unsupportedDeclarations].flatMap(
      (declaration) => {
        const exported = directExportName(declaration);
        return exported === undefined ? [] : [exported];
      },
    );
  }

  function specifierExportNames(declaration: SourceFileIr["exports"][number]): readonly string[] {
    if (declaration.kind === "local-named" || declaration.kind === "reexport-named") {
      return declaration.specifiers.map((specifier) => specifier.exported);
    }
    if (declaration.kind === "default-local") {
      return ["default"];
    }
    return declaration.kind === "namespace" ? [declaration.exported] : [];
  }

  function starExportNames(
    record: ModuleRecord,
    declaration: Extract<SourceFileIr["exports"][number], { readonly kind: "reexport-all" }>,
    visited: Set<string>,
  ): readonly string[] {
    const target = resolveModule(record.source, declaration.moduleSpecifier, false);
    if (target?.record === undefined) {
      return [];
    }
    return [...enumerateNames(target.record, visited)].filter((name) => name !== "default");
  }

  function enumerateNames(record: ModuleRecord, visited: Set<string>): ReadonlySet<string> {
    if (visited.has(record.source.fileId)) {
      return new Set<string>();
    }
    visited.add(record.source.fileId);
    const unit = record.source.unit;
    const names = new Set<string>(declaredExportNames(unit));
    for (const declaration of unit.exports) {
      const exported =
        declaration.kind === "reexport-all"
          ? starExportNames(record, declaration, visited)
          : specifierExportNames(declaration);
      for (const name of exported) {
        names.add(name);
      }
    }
    return names;
  }

  const collected = new Map<string, CollectedSymbol>();
  const reportedCollisions = new Set<string>();

  function register(subpath: string, exportedName: string, symbol: LinkedSymbol): void {
    const external = symbol.external;
    if (
      external === undefined ||
      external.packageName !== manifest.name ||
      (symbol.kind !== "class" && symbol.kind !== "interface")
    ) {
      // 转手 re-export 的他包符号不属于本包户口表：应用侧对它们同样归属到定义包，坐标在
      // meta 构建阶段按外部符号处理。非 class/interface 声明在消费侧不建锚，也不登记。
      return;
    }
    const coordinate = parseContractCoordinate(external.coordinate);
    if (coordinate?.kind !== "file") {
      return;
    }
    const id = `${manifest.name}#${coordinate.exportName}`;
    const existing = collected.get(id);
    if (existing === undefined) {
      collected.set(id, {
        anchorFile: coordinate.file,
        anchorExportName: coordinate.exportName,
        symbol,
        locations: [{ subpath, exportedName }],
      });
      return;
    }
    if (existing.anchorFile !== coordinate.file) {
      if (!reportedCollisions.has(id)) {
        reportedCollisions.add(id);
        diagnostics.push(
          diagnostic({
            code: "LIBRARY_EXPORT_MISMATCH",
            message: `Public exports resolve ${id} to two different declaration files.`,
            related: [{ message: existing.anchorFile }, { message: coordinate.file }],
            help: "Rename one export; a meta coordinate must anchor exactly one declaration.",
          }),
        );
      }
      return;
    }
    existing.locations.push({ subpath, exportedName });
  }

  for (const entry of manifest.subpaths) {
    const physicalPath = moduleKey(entry.typesFile);
    const record = store.recordAt(physicalPath);
    if (record === undefined) {
      diagnostics.push(
        diagnostic({
          code: "INVALID_LIBRARY_PACKAGE",
          message: `Exports subpath ${entry.subpath} types entry cannot be parsed: ${entry.typesFile}.`,
          help: "Build the package dist before reforce lib and point exports types targets at valid declaration files.",
        }),
      );
      continue;
    }
    const names = [...enumerateNames(record, new Set())]
      .filter((name) => record.ambiguousExports?.has(name) !== true)
      .sort(compareUtf16CodeUnits);
    for (const name of names) {
      const symbol = binder.resolveModuleExportFor({ physicalPath, record }, name);
      if (symbol !== undefined) {
        register(entry.subpath, name, symbol);
      }
    }
  }

  const symbols = [...collected.entries()]
    .map(([id, entry]) => {
      const locations = entry.locations.toSorted(
        (left, right) =>
          compareUtf16CodeUnits(left.subpath, right.subpath) ||
          compareUtf16CodeUnits(left.exportedName, right.exportedName),
      );
      const subpaths = [...new Set(locations.map((location) => location.subpath))];
      return {
        id,
        anchorFile: entry.anchorFile,
        anchorExportName: entry.anchorExportName,
        symbol: entry.symbol,
        subpaths,
        locations,
      };
    })
    .toSorted((left, right) => compareUtf16CodeUnits(left.id, right.id));
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));

  return {
    symbols,
    symbolById(id) {
      return byId.get(id);
    },
    resolveFromDirectory,
    locatePackage,
    collectWatchDependencies,
  };
}
