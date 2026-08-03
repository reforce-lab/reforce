import * as nodeFileSystem from "node:fs";
import path from "node:path";
import enhancedResolve from "enhanced-resolve";
import type { CompilerDiagnostic, ResolvedApplicationProject } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { LinkedSymbol } from "@/linking/model";
import { isPathContained } from "@/project/path-identity";
import type { ParsedSource } from "@/project/source-files";

// enhanced-resolve module resolution for the linker: owns the resolver instances, the resolution
// cache, resolution-failure reporting, and the watch-dependency sets that resolution feeds.
// The mutable sets are shared with the linker by reference so late resolutions during analysis
// keep landing in the same missingDependencies set the linker exposes.

export interface ImportReference {
  readonly moduleSpecifier: string;
  readonly imported: string;
  readonly namespace: boolean;
}

export interface ModuleRecord {
  readonly source: ParsedSource;
  readonly localSymbols: ReadonlyMap<string, LinkedSymbol>;
  readonly imports: ReadonlyMap<string, ImportReference>;
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

function isStrictAncestor(directory: string, target: string): boolean {
  const pathFromDirectory = path.relative(directory, target);
  return (
    pathFromDirectory !== "" &&
    !path.isAbsolute(pathFromDirectory) &&
    pathFromDirectory !== ".." &&
    !pathFromDirectory.startsWith(`..${path.sep}`)
  );
}

function shouldWatchResolverDirectory(directory: string, projectRoot: string): boolean {
  if (isPathContained(projectRoot, directory)) {
    return true;
  }
  if (isStrictAncestor(directory, projectRoot)) {
    return false;
  }
  return !isStrictAncestor(nodeFileSystem.realpathSync(directory), projectRoot);
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

  return { resolveModule, collectWatchDependencies };
}
