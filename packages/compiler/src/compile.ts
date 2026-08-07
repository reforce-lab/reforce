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
import { applySuppressions } from "@/suppressions";
import { CheckerUnavailableError } from "@/typescript/checker-errors";
import type { CheckerSession } from "@/typescript/checker-session";

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

// checker 不可用只在这里翻译成诊断(RFC 0012 S1,#273):字段表算法与门面内部零 try/catch,
// CheckerUnavailableError 一路穿透到 compile 这一处收口,走 failure() 路径。
function checkerUnavailableDiagnostic(error: CheckerUnavailableError): CompilerDiagnostic {
  return diagnostic({
    code: "TYPE_CHECKER_UNAVAILABLE",
    message: "The TypeScript checker process is unavailable for this compilation.",
    help: "Re-run the compilation; the checker session is rebuilt automatically on the next pass.",
    cause: error,
  });
}

export async function compile(
  request: CompileRequest,
  state: ProjectState | undefined,
  cache: LRUCache<string, SourceFileIr>,
  checkerSession?: CheckerSession,
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
  // lease 是懒的:S1 里 analyzeProject 只透传 typeQuery 不消费,不查询就不 spawn tsgo,
  // 普通编译零开销;retire 只作废句柄代,tsgo snapshot 跨 compile 保留复用。
  const checkerLease = checkerSession?.lease({
    tsconfigPath: request.project.tsconfigPath,
    trackedFiles: state.parsedConfig.fileNames,
  });
  // watch inputs 必须在 analyzeProject 之后收集:分析期 linker 还会追加 link 阶段才解析到的
  // 声明端点,提前快照会把它们漏掉(Issue #26)。
  const analysisWatchInputs = () =>
    mergeWatchInputs(parsed.watchInputs, linker.collectWatchInputs());
  let analysis: ReturnType<typeof analyzeProject>;
  try {
    analysis = analyzeProject(parsed.sources, linker, checkerLease?.query);
  } catch (error) {
    if (error instanceof CheckerUnavailableError) {
      return failure([checkerUnavailableDiagnostic(error)], analysisWatchInputs());
    }
    throw error;
  } finally {
    checkerLease?.retire();
  }
  const watchInputs = analysisWatchInputs();
  // 抑制在分派之前应用（RFC 0011 D7，#242）。抑制只作用于 warning，所以失败分析里那些 error
  // 一条不少地留下，failure() 拿得到诊断；成功分析这边压掉全部 warning 后也仍然是 success——
  // 这正是最容易漏的一条：把抑制放在 failure() 之后，「全部被抑制」会撞上
  // "Compile failure requires a diagnostic"。
  const suppressionSources = parsed.sources.map((source) => ({
    fileId: source.fileId,
    suppressions: source.unit.suppressions,
  }));
  if (analysis.status === "failure") {
    return failure(
      applySuppressions(analysis.diagnostics, suppressionSources).diagnostics,
      watchInputs,
    );
  }
  return {
    status: "success",
    // 分析成功即无 error，而抑制只会追加 warning，所以这里必然全是 warning。
    diagnostics: orderDiagnostics(
      applySuppressions(analysis.diagnostics, suppressionSources).diagnostics,
    ),
    files: generateFiles(
      request.project,
      analysis.providers,
      analysis.configs,
      analysis.plans,
      analysis.web,
      analysis.weaving,
      linker.starterLinkage,
    ),
    watchInputs,
  };
}
