import { compareUtf16CodeUnits } from "@reforce/primitives";
import { analyzeClassProvider } from "@/analysis/class-provider";
import { analyzeConfigProviders } from "@/analysis/config-provider";
import { createExecutionPlans } from "@/analysis/execution-plan";
import { analyzeFactoryProvider } from "@/analysis/factory-provider";
import type {
  BeanProviderModel,
  ConfigProviderModel,
  ExecutionPlansModel,
  ProviderDraft,
  ProviderModel,
} from "@/analysis/model";
import { resolveProviders } from "@/analysis/resolve-providers";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { ProjectLinker } from "@/linking/project-linker";
import type { ClassDeclaration } from "@/parser/source-ir";
import type { ParsedSource } from "@/project/source-files";

interface AnalysisSuccess {
  readonly status: "success";
  readonly providers: readonly BeanProviderModel[];
  readonly configs: readonly ConfigProviderModel[];
  readonly plans: ExecutionPlansModel;
}

interface AnalysisFailure {
  readonly status: "failure";
  readonly diagnostics: readonly [CompilerDiagnostic, ...CompilerDiagnostic[]];
}

type AnalysisResult = AnalysisSuccess | AnalysisFailure;

function nonEmptyDiagnostics(
  diagnostics: readonly CompilerDiagnostic[],
): readonly [CompilerDiagnostic, ...CompilerDiagnostic[]] {
  const first = diagnostics[0];
  if (first === undefined) {
    throw new Error("Expected at least one diagnostic");
  }
  return [first, ...diagnostics.slice(1)];
}

function validateModuleSyntax(
  sources: readonly ParsedSource[],
  diagnostics: CompilerDiagnostic[],
): void {
  for (const source of sources) {
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
}

function sourceProviderDrafts(
  source: ParsedSource,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
  claimedByConfig: ReadonlySet<ClassDeclaration>,
): readonly ProviderDraft[] {
  // config 分析已认领的 class（含形状非法的 config 声明）不再作为普通 provider 复查，
  // 否则同一个类会拿到两套互相矛盾的诊断。
  const classDrafts = source.unit.classes
    .filter((declaration) => !claimedByConfig.has(declaration))
    .map((declaration) => analyzeClassProvider(source, declaration, linker, diagnostics));
  const factoryDrafts = source.unit.beanFactories.map((declaration) =>
    analyzeFactoryProvider(source, declaration, linker, diagnostics),
  );
  return [...classDrafts, ...factoryDrafts].filter((draft) => draft !== undefined);
}

function collectProviderDrafts(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
  claimedByConfig: ReadonlySet<ClassDeclaration>,
): readonly ProviderDraft[] {
  return sources
    .filter((source) => !source.sourceKind.startsWith("d."))
    .flatMap((source) => sourceProviderDrafts(source, linker, diagnostics, claimedByConfig));
}

function isBeanProvider(provider: ProviderModel): provider is BeanProviderModel {
  return provider.kind !== "config";
}

export function analyzeProject(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
): AnalysisResult {
  const diagnostics: CompilerDiagnostic[] = [];
  validateModuleSyntax(sources, diagnostics);
  const configAnalysis = analyzeConfigProviders(sources, linker, diagnostics);
  const drafts = collectProviderDrafts(sources, linker, diagnostics, configAnalysis.claimed);

  // starter 契约解析仍会经 binder 推新的 linker 诊断，所以 linker.diagnostics 必须在
  // resolveProviders 之后再并入；顺序无所谓，最终由 orderDiagnostics 排序去重。
  const starterDrafts = resolveProviders(
    [...configAnalysis.drafts, ...drafts],
    linker.starterLinkage,
    diagnostics,
  );
  diagnostics.push(...linker.diagnostics);

  if (diagnostics.length > 0) {
    return { status: "failure", diagnostics: nonEmptyDiagnostics(diagnostics) };
  }
  // 物化集合即可达子图（ADR 0004 决策 11，#120）：未被需求的 starter bean 从未成为 draft，
  // 执行计划照旧在全量 providers 上排序，确定性排序保证不变。config 不进执行计划——它由
  // 绑定 phase 先于一切 bean 构造（ADR 0005 决策 6.1），指向 config 的 eager 边视为恒就绪。
  const allProviders = [...configAnalysis.drafts, ...drafts, ...starterDrafts]
    .map((draft) => draft.provider)
    .toSorted((left, right) => compareUtf16CodeUnits(left.id, right.id));
  const providers = allProviders.filter(isBeanProvider);
  const configs = allProviders.flatMap((provider) =>
    provider.kind === "config" ? [provider] : [],
  );
  return {
    status: "success",
    providers: Object.freeze(providers),
    configs: Object.freeze(configs),
    plans: createExecutionPlans(providers, new Set(configs.map((config) => config.id))),
  };
}
