import { isBuiltin } from "node:module";
import path from "node:path";
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
  ValueDeclaration,
} from "@/parser/source-ir";
import type { ParsedSource } from "@/project/source-files";
import { createWatchInputs } from "@/project/watch-inputs";

// 值声明的解析结果（ADR 0006 W3/W5，#152）：exportName 是"从声明模块 import 该值"要用的
// 名字——emission 据此在 routes.ts 里重建 import；declaration 供分析层核实形状（marker 的
// defineRouteMarker 调用、schema 的导出 const）。
export interface ResolvedValueDeclaration {
  readonly source: ParsedSource;
  // 从声明模块 import 该值要用的名字；本文件声明且未导出时缺省——marker 的同文件使用不需要
  // 导出，schema 引用则必须可 import，由调用方按各自约束诊断。
  readonly exportName?: string;
  readonly declaration: ValueDeclaration;
}

export interface ProjectLinker {
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly starterLinkage: StarterLinkage;
  // defineApplication 所在的应用模块（顶层至多一次由注册读取保证）；未注册任何 starter 时
  // 缺省。web 接线的 webRequestSeeder 约定以它为查找作用域（ADR 0006 W2 的 #153 修订）。
  readonly applicationModule?: ParsedSource;
  collectWatchInputs(): CompilerWatchInputs;
  resolveEntity(source: ParsedSource, entity: EntityName): LinkedSymbol | undefined;
  resolveType(source: ParsedSource, type: TypeNode): LinkedType | undefined;
  // 名字在 source 语境下指向的顶层值声明：本文件声明，或一跳具名 import 的目标模块直接
  // 导出。不追 re-export 链（路由 schema / marker 的 v1 边界，越界由调用方给出诊断）。
  resolveValueDeclaration(source: ParsedSource, name: string): ResolvedValueDeclaration | undefined;
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
  // 定位过的外部包根都记账：watch 面收敛（见 collectWatchInputs）要按"已知包根的严格祖先"
  // 识别解析走链带出的项目外高层目录。
  const locatedPackageRoots = new Set<string>();
  const packageLocator = createPackageLocator();
  const locatePackage: typeof packageLocator = (physicalPath) => {
    const location = packageLocator(physicalPath);
    if (location !== undefined) {
      locatedPackageRoots.add(location.rootPath);
    }
    return location;
  };
  // binder 的每次查询都现读 records，因此可以在外部闭包装载前创建：注册读取只会命中应用记录
  // 与 @reforce/core 特例，装载后同一实例自动看见外部记录。
  const binder = createExportBinder({ diagnostics, resolveModule });

  // fileId 索引只覆盖应用源码集；外部闭包的记录按物理路径入账（external-modules 的
  // records.set(physicalPath)，而外部 ParsedSource.absolutePath 就是那个已 moduleKey 过的
  // 路径）。extends 上溯要在基类自己的模块作用域里解析它的构造器参数类型（#350），基类可能
  // 只存在于 node_modules 的 .d.ts 里，所以这里必须能按外部 source 找回记录。
  function recordFor(source: ParsedSource): ModuleRecord {
    const record = recordsByFileId.get(source.fileId) ?? records.get(source.absolutePath);
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

  // Lazy<T> 与 Current<T> 同族（ADR 0006 W7）：都是"注入句柄、取值在调用时刻"的包装标记，
  // 链接层只负责剥一层包装并打标；包装的合法组合（scope 两侧、嵌套）由分析层裁决。
  function resolveHandleType(
    source: ParsedSource,
    type: Extract<TypeNode, { readonly kind: "reference" }>,
    outer: LinkedSymbol | undefined,
  ): { readonly matched: boolean; readonly type?: LinkedType } {
    if (
      outer?.kind !== "core" ||
      (outer.name !== "Lazy" && outer.name !== "Current") ||
      type.typeArguments.length !== 1
    ) {
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
            lazy: outer.name === "Lazy",
            current: outer.name === "Current",
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
          current: false,
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
    const handle = resolveHandleType(source, type, outer);
    if (handle.matched) {
      return handle.type;
    }
    if (outer !== undefined) {
      return {
        symbol: outer,
        typeArguments: type.typeArguments,
        lazy: false,
        current: false,
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

  function localExportNameOf(record: ModuleRecord, localName: string): string | undefined {
    const declaration = record.source.unit.valueDeclarations.find(
      (candidate) => candidate.topLevel && candidate.name === localName,
    );
    if (declaration?.export.kind === "named") {
      return declaration.export.exportedName;
    }
    for (const exported of record.source.unit.exports) {
      if (exported.kind !== "local-named") {
        continue;
      }
      const specifier = exported.specifiers.find((candidate) => candidate.local === localName);
      if (specifier !== undefined) {
        return specifier.exported;
      }
    }
    return undefined;
  }

  function exportedValueOf(
    record: ModuleRecord,
    exportedName: string,
  ): ResolvedValueDeclaration | undefined {
    const direct = record.source.unit.valueDeclarations.find(
      (candidate) =>
        candidate.topLevel &&
        candidate.export.kind === "named" &&
        candidate.export.exportedName === exportedName,
    );
    if (direct !== undefined) {
      return { source: record.source, exportName: exportedName, declaration: direct };
    }
    for (const exported of record.source.unit.exports) {
      if (exported.kind !== "local-named") {
        continue;
      }
      const specifier = exported.specifiers.find(
        (candidate) => candidate.exported === exportedName,
      );
      if (specifier === undefined) {
        continue;
      }
      const local = record.source.unit.valueDeclarations.find(
        (candidate) => candidate.topLevel && candidate.name === specifier.local,
      );
      if (local !== undefined) {
        return { source: record.source, exportName: exportedName, declaration: local };
      }
    }
    return undefined;
  }

  function resolveValueDeclaration(
    source: ParsedSource,
    name: string,
  ): ResolvedValueDeclaration | undefined {
    const record = recordFor(source);
    const local = record.source.unit.valueDeclarations.find(
      (candidate) => candidate.topLevel && candidate.name === name,
    );
    if (local !== undefined) {
      const exportName = localExportNameOf(record, name);
      return {
        source: record.source,
        ...(exportName === undefined ? {} : { exportName }),
        declaration: local,
      };
    }
    const imported = record.imports.get(name);
    if (imported === undefined || imported.namespace) {
      return undefined;
    }
    const target = resolveModule(source, imported.moduleSpecifier);
    if (target?.record === undefined) {
      return undefined;
    }
    return exportedValueOf(target.record, imported.imported);
  }

  return {
    // diagnostics must stay the live array: resolveType and the export binder keep pushing
    // diagnostics while analysis runs, and analysis reads linker.diagnostics only after it
    // finishes — a snapshot here would silently drop those late diagnostics.
    get diagnostics() {
      return diagnostics;
    },
    starterLinkage,
    ...(registrations.length === 0 ? {} : { applicationModule: registrations[0]?.source }),
    // Same timing constraint: the closures above keep resolving modules while analysis runs — a
    // re-export of the context specifier is resolved there for the first time, because
    // the external closure loader skips it — so this must be called after analysis finishes, never
    // snapshotted before it (Issue #26). Each call re-classifies every resolver dependency, which
    // is why compile() calls it exactly once.
    collectWatchInputs() {
      const dependencies = collectWatchDependencies();
      // watch 面收敛（#153 发现的失控场景）：workspace symlink 的外部包（starter 或类型依赖）
      // 以 realpath 形态参与解析，解析器从真实包目录向上的 node_modules 走链会把 /Users 一类
      // 项目外高层祖先写进 context 依赖——它们不含 node_modules / dist 段，watcher 的具名
      // 目录忽略拦不住，rspack 原生 watcher 对这类目录的递归扫描无界（实测整个 home 目录被
      // 爬取、CPU 持续打满且项目内变更事件全部丢失）。外部包根本身保留（既有契约：symlink
      // workspace 包的物理目录参与失效；对它的爬取有界——node_modules 子树被具名段忽略），
      // 丢弃的只有"已知包根的严格祖先且在项目外"的目录。
      // 单文件依赖不受限（跨目录 tsconfig extends 失效是 dev-watch-build 钉住的契约，文件监视
      // 不引发目录递归扫描），但已注册 starter 包内的文件除外——安装内容视为不可变，其变更的
      // 重建信号是项目内 package.json / pnpm-lock.yaml（dev-watch-signals 钉住的通道）。
      const starterRoots = registry.starters.map((starter) => starter.rootPath);
      const projectPrefix = `${project.projectRoot}${path.sep}`;
      const insideProject = (dependency: string) =>
        dependency === project.projectRoot || dependency.startsWith(projectPrefix);
      const holdsLocatedPackageRoot = (dependency: string) => {
        const prefix = `${dependency}${path.sep}`;
        return [...locatedPackageRoots].some((root) => root.startsWith(prefix));
      };
      const watchableDirectory = (dependency: string) =>
        insideProject(dependency) || !holdsLocatedPackageRoot(dependency);
      const withinStarterPackage = (dependency: string) =>
        starterRoots.some(
          (root) => dependency === root || dependency.startsWith(`${root}${path.sep}`),
        );
      return createWatchInputs({
        fileDependencies: [...dependencies.fileDependencies].filter(
          (dependency) => !withinStarterPackage(dependency),
        ),
        contextDependencies: [...dependencies.contextDependencies].filter(watchableDirectory),
        missingDependencies: [...dependencies.missingDependencies].filter(watchableDirectory),
      });
    },
    resolveEntity,
    resolveType,
    resolveValueDeclaration,
    symbolForDeclaration,
  };
}
