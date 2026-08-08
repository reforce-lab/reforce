import * as nodeFileSystem from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { isPathContained, isPathStrictlyContained } from "@reforce/primitives";
import enhancedResolve from "enhanced-resolve";
import type { CompilerDiagnostic, ResolvedApplicationProject } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { LinkedSymbol } from "@/linking/model";
import type { ParsedSource } from "@/project/source-files";

// enhanced-resolve module resolution for the linker: owns the resolver instances, the resolution
// cache, resolution-failure reporting, and the watch-dependency sets that resolution feeds.
// collectWatchDependencies classifies whatever has been resolved so far, so the linker has to call
// it after linking finishes instead of caching an early result (Issue #26).

export interface ImportReference {
  readonly moduleSpecifier: string;
  readonly imported: string;
  readonly namespace: boolean;
}

export interface ModuleRecord {
  readonly source: ParsedSource;
  readonly localSymbols: ReadonlyMap<string, LinkedSymbol>;
  readonly imports: ReadonlyMap<string, ImportReference>;
  // 仅外部记录使用：同名多次导出且指向不同声明的导出名。ESM 里这是非法输入，绑定层必须拒绝
  // 解析而不是静默取第一个（IT 钉住 TYPE_LINK_FAILED）；应用源文件保持既有语义，不设此集合。
  readonly ambiguousExports?: ReadonlySet<string>;
}

export interface ResolvedModule {
  readonly physicalPath: string;
  readonly record?: ModuleRecord;
}

export type ModuleResolver = (
  source: ParsedSource,
  specifier: string,
  reportFailure?: boolean,
) => ResolvedModule | undefined;

export function moduleKey(file: string): string {
  try {
    return nodeFileSystem.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function shouldWatchResolverDirectory(directory: string, projectRoot: string): boolean {
  if (isPathContained(projectRoot, directory)) {
    return true;
  }
  // 严格变体：directory === projectRoot 的情形已被上面的含自身判定接住，这里问的是"directory 是不是
  // projectRoot 的真祖先"——真祖先（比如仓库根、`/`）改动跟本项目无关，不该进 watch 集。
  if (isPathStrictlyContained(directory, projectRoot)) {
    return false;
  }
  return !isPathStrictlyContained(nodeFileSystem.realpathSync(directory), projectRoot);
}

function classifyResolverDependencies(
  resolverDependencies: ReadonlySet<string>,
  projectRoot: string,
  fileDependencies: Set<string>,
  contextDependencies: Set<string>,
  missingDependencies: Set<string>,
): void {
  for (const dependency of resolverDependencies) {
    try {
      if (!nodeFileSystem.statSync(dependency).isDirectory()) {
        fileDependencies.add(dependency);
        continue;
      }
      if (shouldWatchResolverDirectory(dependency, projectRoot)) {
        contextDependencies.add(dependency);
      }
    } catch {
      missingDependencies.add(dependency);
    }
  }
}

export function createModuleResolver(
  records: ReadonlyMap<string, ModuleRecord>,
  diagnostics: CompilerDiagnostic[],
  project: ResolvedApplicationProject,
  customConditions: readonly string[],
) {
  const resolverFileDependencies = new Set<string>();
  const resolverContextDependencies = new Set<string>();
  const missingDependencies = new Set<string>();
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
    contextDependencies: resolverContextDependencies,
    missingDependencies,
  };
  const resolvedModules = new Map<string, string | false>();
  const reportedFailures = new Set<string>();

  function resolutionKey(containing: ParsedSource, specifier: string): string {
    return `${containing.absolutePath}\0${specifier}`;
  }

  function resolveUncachedModule(containing: ParsedSource, specifier: string): string | false {
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
    return moduleKey(resolved);
  }

  function resolveModule(
    containing: ParsedSource,
    specifier: string,
    reportFailure = true,
  ): ResolvedModule | undefined {
    // Node 内置模块（node:http 等）不在文件系统上：按"可消费的外部符号"处理，永不解析也
    // 永不报 MODULE_RESOLUTION_FAILED（#207：Node 引擎 starter 首次把 node:* 值引入
    // 带进库模式编译）。
    if (isBuiltin(specifier)) {
      return undefined;
    }
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
    // record 每次都从 records 现查：外部模块记录在链接前的闭包加载阶段陆续补进同一张表，
    // 缓存住早期查到的 undefined 会让 binder 把已建档的外部文件继续当成两比特外部符号处理。
    const record = records.get(result);
    return record === undefined ? { physicalPath: result } : { physicalPath: result, record };
  }

  // starter meta（`<pkg>/reforce-meta`，ADR 0004 决策 2）与包根探测共用的裸解析入口：不带
  // tsconfig paths（包坐标必须按 node 语义落点），json 目标按 exports 字面 target 命中。
  const resolveRawTarget = enhancedResolve.create.sync({
    descriptionFiles: ["package.json"],
    exportsFields: ["exports"],
    extensions: [".json", ".ts", ".d.ts", ".js"],
    conditionNames: ["types", ...customConditions, "import", "default"],
    mainFields: ["types", "typings", "module", "main"],
    fileSystem: nodeFileSystem,
    symlinks: true,
    useSyncFileSystemCalls: true,
  });

  function resolveFromDirectory(directory: string, specifier: string): string | undefined {
    try {
      const resolved = resolveRawTarget(directory, specifier, resolutionContext);
      if (resolved === false) {
        return undefined;
      }
      resolverFileDependencies.add(resolved);
      return moduleKey(resolved);
    } catch {
      return undefined;
    }
  }

  function collectWatchDependencies() {
    const fileDependencies = new Set<string>();
    const contextDependencies = new Set<string>();
    classifyResolverDependencies(
      resolverFileDependencies,
      project.projectRoot,
      fileDependencies,
      contextDependencies,
      missingDependencies,
    );
    classifyResolverDependencies(
      resolverContextDependencies,
      project.projectRoot,
      fileDependencies,
      contextDependencies,
      missingDependencies,
    );
    return { fileDependencies, contextDependencies, missingDependencies };
  }

  return { resolveModule, resolveFromDirectory, collectWatchDependencies };
}
