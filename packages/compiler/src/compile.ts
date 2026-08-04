import type { LRUCache } from "lru-cache";
import { analyzeProject } from "@/analysis/analyze-project";
import type { CompileRequest, CompileResult, CompilerDiagnostic, CompilerWatchInputs } from "@/api";
import { diagnostic, orderDiagnostics } from "@/diagnostics";
import { generateFiles } from "@/emission/generate-files";
import { createProjectLinker } from "@/linking/project-linker";
import type { SourceFileIr } from "@/parser/source-ir";
import type { ProjectState } from "@/project/project-config";
import { snapshotStillMatches } from "@/project/project-snapshot";
import { parseProjectSources } from "@/project/source-files";
import { createWatchInputs, mergeWatchInputs } from "@/project/watch-inputs";

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

export async function compile(
  request: CompileRequest,
  state: ProjectState | undefined,
  cache: LRUCache<string, SourceFileIr>,
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
      state?.watchInputs ?? createWatchInputs(),
    );
  }

  const parsed = await parseProjectSources(request.project, state, cache);
  if (parsed.status === "failure") {
    return failure(parsed.diagnostics, parsed.watchInputs);
  }
  const linker = await createProjectLinker(
    parsed.sources,
    request.project,
    cache,
    state.parsedConfig.config.compilerOptions?.customConditions,
  );
  const analysis = analyzeProject(parsed.sources, linker);
  const watchInputs = mergeWatchInputs(parsed.watchInputs, linker.collectWatchInputs());
  if (analysis.status === "failure") {
    return failure(analysis.diagnostics, watchInputs);
  }
  return {
    status: "success",
    diagnostics: [],
    files: generateFiles(
      request.project,
      analysis.providers,
      analysis.configs,
      analysis.plans,
      analysis.web,
      linker.starterLinkage,
    ),
    watchInputs,
  };
}
