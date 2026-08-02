import type { CompilerDiagnostic } from "../api";
import { compareUtf16CodeUnits } from "../determinism";
import { diagnostic } from "../diagnostics";
import type { ProjectLinker } from "../linking/project-linker";
import type { ParsedSource } from "../project/source-files";
import { analyzeClassProvider } from "./class-provider";
import { createExecutionPlans } from "./execution-plan";
import { analyzeFactoryProvider } from "./factory-provider";
import type { ExecutionPlansModel, ProviderDraft, ProviderModel } from "./model";
import { resolveProviders } from "./resolve-providers";

interface AnalysisSuccess {
  readonly status: "success";
  readonly providers: readonly ProviderModel[];
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

function collectProviderDrafts(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): readonly ProviderDraft[] {
  const drafts: ProviderDraft[] = [];
  for (const source of sources) {
    if (source.sourceKind.startsWith("d.")) {
      continue;
    }
    for (const declaration of source.unit.classes) {
      const draft = analyzeClassProvider(source, declaration, linker, diagnostics);
      if (draft !== undefined) {
        drafts.push(draft);
      }
    }
    for (const declaration of source.unit.beanFactories) {
      const draft = analyzeFactoryProvider(source, declaration, linker, diagnostics);
      if (draft !== undefined) {
        drafts.push(draft);
      }
    }
  }
  return drafts;
}

export function analyzeProject(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
): AnalysisResult {
  const diagnostics: CompilerDiagnostic[] = [];
  validateModuleSyntax(sources, diagnostics);
  const drafts = collectProviderDrafts(sources, linker, diagnostics);

  diagnostics.push(...linker.diagnostics);
  resolveProviders(drafts, diagnostics);

  if (diagnostics.length > 0) {
    return { status: "failure", diagnostics: nonEmptyDiagnostics(diagnostics) };
  }
  const providers = drafts
    .map((draft) => draft.provider)
    .toSorted((left, right) => compareUtf16CodeUnits(left.id, right.id));
  return {
    status: "success",
    providers: Object.freeze(providers),
    plans: createExecutionPlans(providers),
  };
}
