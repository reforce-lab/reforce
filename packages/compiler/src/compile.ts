import type { LRUCache } from "lru-cache";
import { analyzeProject } from "@/analysis/analyze-project";
import { validateLoggerLevelKeys } from "@/analysis/logger-levels";
import type { CompileRequest, CompileResult, CompilerDiagnostic, CompilerWatchInputs } from "@/api";
import { diagnostic, orderDiagnostics } from "@/diagnostics";
import { generateFiles } from "@/emission/generate-files";
import { createProjectLinker } from "@/linking/project-linker";
import type { SourceFileIr } from "@/parser/source-ir";
import { readEnvironmentKeyLayers } from "@/project/env-layers";
import type { ProjectState } from "@/project/project-config";
import { snapshotStillMatches } from "@/project/project-snapshot";
import { parseProjectSources } from "@/project/source-files";
import { createWatchInputs, mergeWatchInputs } from "@/project/watch-inputs";
import { applySuppressions } from "@/suppressions";

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
  // logging.level.* 的编译期校验（RFC 0011 L5，#242）。.env 层进 watch inputs：存在的进
  // fileDependencies，缺席的进 missingDependencies——后者是 dev 下「新建 .env 触发重编译」
  // 的唯一通道（先例逐字照 library/compile.ts 的 packageJsonWatch）。
  const environment = readEnvironmentKeyLayers({
    projectRoot: request.project.projectRoot,
    env: process.env,
  });
  const levelDiagnostics: CompilerDiagnostic[] = [];
  validateLoggerLevelKeys({
    environmentKeys: environment.keys,
    loggerNames: analysis.loggerNames,
    diagnostics: levelDiagnostics,
  });
  const withEnvironment = mergeWatchInputs(
    watchInputs,
    createWatchInputs({
      fileDependencies: environment.presentFiles,
      missingDependencies: environment.missingFiles,
    }),
  );
  return {
    status: "success",
    // 分析成功即无 error，而抑制只会追加 warning，所以这里必然全是 warning。
    diagnostics: orderDiagnostics(
      applySuppressions([...analysis.diagnostics, ...levelDiagnostics], suppressionSources)
        .diagnostics,
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
    watchInputs: withEnvironment,
  };
}
