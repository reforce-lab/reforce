import type { LRUCache } from "lru-cache";
import { analyzeProject } from "#internal/analysis/analyze-project";
import { sortNativePaths } from "#internal/determinism";
import { diagnostic, orderDiagnostics } from "#internal/diagnostics";
import { renderGeneratedFiles } from "#internal/emission/render-generated";
import type { CachedParse } from "#internal/incremental/parse-cache";
import { createLinker } from "#internal/linking/module-graph";
import { snapshotStillMatches } from "#internal/project/config";
import { parseProjectSources } from "#internal/project/source-files";
import type {
  CompileRequest,
  CompileResult,
  CompilerDiagnostic,
  CompilerWatchInputs,
  ProjectState,
} from "#internal/types";

function failure(
  diagnostics: readonly CompilerDiagnostic[],
  watchInputs: CompilerWatchInputs,
): CompileResult {
  const ordered = orderDiagnostics(diagnostics);
  const first = ordered[0];
  if (first === undefined) {
    throw new Error("Compile failure requires a diagnostic");
  }
  return {
    status: "failure",
    diagnostics: [first, ...ordered.slice(1)],
    watchInputs,
  };
}

function mergeWatchInputs(
  current: CompilerWatchInputs,
  additional: CompilerWatchInputs,
): CompilerWatchInputs {
  return Object.freeze({
    fileDependencies: sortNativePaths([
      ...current.fileDependencies,
      ...additional.fileDependencies,
    ]),
    contextDependencies: sortNativePaths([
      ...current.contextDependencies,
      ...additional.contextDependencies,
    ]),
    missingDependencies: sortNativePaths([
      ...current.missingDependencies,
      ...additional.missingDependencies,
    ]),
  });
}

export async function compileProject(
  request: CompileRequest,
  state: ProjectState | undefined,
  cache: LRUCache<string, CachedParse>,
): Promise<CompileResult> {
  if (state === undefined || !(await snapshotStillMatches(state.snapshot))) {
    return failure(
      [
        diagnostic({
          code: "PROJECT_CONFIG_CHANGED",
          message: "The resolved application project changed before compilation.",
          help: "Resolve the project again before compiling; do not reuse a project from another Compiler instance.",
        }),
      ],
      state?.watchInputs ?? {
        fileDependencies: Object.freeze([]),
        contextDependencies: Object.freeze([]),
        missingDependencies: Object.freeze([]),
      },
    );
  }

  const parsed = await parseProjectSources(request.project, state, request.frontend, cache);
  if (parsed.status === "failure") {
    return failure(parsed.diagnostics, parsed.watchInputs);
  }
  const linker = await createLinker(
    parsed.sources,
    request.project,
    request.frontend,
    cache,
    state.parsedConfig.config.compilerOptions?.customConditions,
  );
  const analysis = analyzeProject(parsed.sources, linker);
  const watchInputs = mergeWatchInputs(parsed.watchInputs, linker);
  if (analysis.status === "failure") {
    return failure(analysis.diagnostics, watchInputs);
  }
  return {
    status: "success",
    diagnostics: [],
    files: renderGeneratedFiles(request.project, analysis.providers, analysis.plans),
    watchInputs,
  };
}
