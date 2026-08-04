import path from "node:path";
import type { LRUCache } from "lru-cache";
import { analyzeClassProvider } from "@/analysis/class-provider";
import type { ProviderDraft } from "@/analysis/model";
import type {
  CompileLibraryRequest,
  CompileLibraryResult,
  CompilerDiagnostic,
  CompilerWatchInputs,
  LibraryGeneratedFile,
} from "@/api";
import { diagnostic, orderDiagnostics } from "@/diagnostics";
import { createLibrarySurface } from "@/library/dist-surface";
import { buildLibraryMeta } from "@/library/meta";
import { readLibraryPackage } from "@/library/package-exports";
import { createProjectLinker, type ProjectLinker } from "@/linking/project-linker";
import type { SourceFileIr } from "@/parser/source-ir";
import type { ProjectState } from "@/project/project-config";
import { snapshotStillMatches } from "@/project/project-snapshot";
import { type ParsedSource, parseProjectSources } from "@/project/source-files";
import { createWatchInputs, mergeWatchInputs } from "@/project/watch-inputs";

// 库模式编译（ADR 0004 决策 1/4，#120/#147）：复用流水线中段——项目解析、源解析、链接与
// provider 采集与应用编译完全同套；不做 resolveProviders / 执行计划 / beans.ts 生成（库的开放
// 依赖本来就允许悬空，装配决策属于应用编译）。draft 采集循环与 analyze-project 同口径，但在
// analysis/ 之外独立实现：#146 正在该目录施工，M2 约定不碰 analysis/linking（#147）。

function failure(
  diagnostics: readonly CompilerDiagnostic[],
  watchInputs: CompilerWatchInputs,
): CompileLibraryResult {
  const ordered = orderDiagnostics(diagnostics);
  const first = ordered[0];
  if (first === undefined) {
    throw new Error("Library compile failure requires a diagnostic");
  }
  return {
    status: "failure",
    diagnostics: [first, ...ordered.slice(1)],
    watchInputs,
  };
}

function unsupportedDeclaration(
  message: string,
  sourceSpan: CompilerDiagnostic["sourceSpan"],
  help: string,
): CompilerDiagnostic {
  return diagnostic({ code: "UNSUPPORTED_LIBRARY_DECLARATION", message, sourceSpan, help });
}

function validateModuleSyntax(source: ParsedSource, diagnostics: CompilerDiagnostic[]): void {
  for (const declaration of [...source.unit.imports, ...source.unit.exports]) {
    if (declaration.kind !== "unsupported-import" && declaration.kind !== "unsupported-export") {
      continue;
    }
    diagnostics.push(
      diagnostic({
        code: "UNSUPPORTED_MODULE_SYNTAX",
        message: `Module syntax ${declaration.syntaxKind} is not supported by the first production compiler.`,
        sourceSpan: declaration.span,
        help: "Use standard ESM import and export declarations without import attributes.",
      }),
    );
  }
}

function rejectUnsupportedCalls(
  source: ParsedSource,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): void {
  for (const declaration of source.unit.applicationDefinitions) {
    const callee = linker.resolveEntity(source, declaration.callee);
    if (callee?.kind === "context" && callee.name === "defineApplication") {
      diagnostics.push(
        unsupportedDeclaration(
          "defineApplication belongs to applications; a starter library cannot declare one.",
          declaration.span,
          "Remove defineApplication from the library source set.",
        ),
      );
    }
  }
  for (const declaration of source.unit.beanFactories) {
    const callee = linker.resolveEntity(source, declaration.callee);
    if (callee?.kind === "context" && callee.name === "defineBean") {
      diagnostics.push(
        unsupportedDeclaration(
          "defineBean factories cannot be published through starter meta v1; meta beans use class construction only.",
          declaration.span,
          "Wrap the factory result in an Injectable class or keep it application-side.",
        ),
      );
    }
  }
}

function rejectUnsupportedDecorators(
  source: ParsedSource,
  declaration: SourceFileIr["classes"][number],
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): void {
  for (const decorator of declaration.decorators) {
    const callee = decorator.callee;
    if (callee.kind === "unsupported-expression") {
      continue;
    }
    const symbol = linker.resolveEntity(source, callee);
    if (symbol?.kind === "context" && (symbol.name === "Primary" || symbol.name === "Qualifier")) {
      diagnostics.push(
        unsupportedDeclaration(
          `@${symbol.name} cannot be expressed in starter meta v1; starter beans have no primary or qualifier surface.`,
          decorator.span,
          "Drop the decorator; applications override starters by declaring a local provider.",
        ),
      );
    }
  }
}

function collectLibraryDrafts(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): readonly ProviderDraft[] {
  const drafts: ProviderDraft[] = [];
  for (const source of sources) {
    validateModuleSyntax(source, diagnostics);
    if (source.sourceKind.startsWith("d.")) {
      continue;
    }
    rejectUnsupportedCalls(source, linker, diagnostics);
    for (const declaration of source.unit.classes) {
      const draft = analyzeClassProvider(source, declaration, linker, diagnostics);
      if (draft !== undefined) {
        drafts.push(draft);
        rejectUnsupportedDecorators(source, declaration, linker, diagnostics);
      }
    }
  }
  return drafts;
}

export async function compileLibrary(
  request: CompileLibraryRequest,
  state: ProjectState | undefined,
  cache: LRUCache<string, SourceFileIr>,
): Promise<CompileLibraryResult> {
  if (state === undefined || !(await snapshotStillMatches(state.snapshot))) {
    return failure(
      [
        diagnostic({
          code: "PROJECT_CONFIG_CHANGED",
          message: "The resolved library project changed before compilation.",
          help: "Resolve the library project again before compiling; do not reuse a project from another Compiler instance.",
        }),
      ],
      state?.watchInputs ?? createWatchInputs(),
    );
  }

  const parsed = await parseProjectSources(request.project, state, cache);
  if (parsed.status === "failure") {
    return failure(parsed.diagnostics, parsed.watchInputs);
  }
  const projectRoot = request.project.projectRoot;
  const packageJsonWatch = createWatchInputs({
    fileDependencies: [path.join(projectRoot, "package.json")],
  });
  const packageResult = await readLibraryPackage(projectRoot);
  if (packageResult.status === "failure") {
    return failure(
      [
        diagnostic({
          code: "INVALID_LIBRARY_PACKAGE",
          message: packageResult.reason,
          help: "reforce lib needs a package.json with a name and an exports map next to the leaf tsconfig.",
        }),
      ],
      mergeWatchInputs(parsed.watchInputs, packageJsonWatch),
    );
  }
  const manifest = packageResult.manifest;
  const customConditions = state.parsedConfig.config.compilerOptions?.customConditions ?? [];
  const linker = await createProjectLinker(
    parsed.sources,
    request.project,
    cache,
    customConditions,
  );
  const diagnostics: CompilerDiagnostic[] = [];
  const drafts = collectLibraryDrafts(parsed.sources, linker, diagnostics);
  const surface = await createLibrarySurface({
    project: request.project,
    manifest,
    cache,
    customConditions,
    diagnostics,
  });
  let files: readonly LibraryGeneratedFile[] = [];
  if (diagnostics.length === 0 && linker.diagnostics.length === 0) {
    files = await buildLibraryMeta({
      packageName: manifest.name,
      projectRoot,
      drafts,
      surface,
      diagnostics,
    });
  }
  const watchInputs = mergeWatchInputs(
    mergeWatchInputs(parsed.watchInputs, linker.collectWatchInputs()),
    mergeWatchInputs(createWatchInputs(surface.collectWatchDependencies()), packageJsonWatch),
  );
  const all = [...diagnostics, ...linker.diagnostics];
  if (all.length > 0) {
    return failure(all, watchInputs);
  }
  return {
    status: "success",
    diagnostics: [],
    packageName: manifest.name,
    files,
    watchInputs,
  };
}
