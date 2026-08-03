import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { LinkedSymbol, LinkedType } from "@/linking/project-linker";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

interface GeneratedSourcePositionModel {
  readonly offset: number;
  readonly line: number;
  readonly character: number;
}

export interface GeneratedSourceReferenceModel {
  readonly file: string;
  readonly start: GeneratedSourcePositionModel;
  readonly end: GeneratedSourcePositionModel;
}

type DependencyMode = "eager" | "cycle-proxy" | "explicit-lazy";

export interface DependencyModel {
  readonly parameterIndex: number;
  readonly targetId: string;
  // execution-plan's cycle marking rewrites "eager" to "cycle-proxy" in place after analysis,
  // so this is the only field that must stay mutable.
  mode: DependencyMode;
  readonly source: GeneratedSourceReferenceModel;
}

export interface QualifierModel {
  readonly interfaceSymbol: LinkedSymbol;
  readonly member: string;
}

interface ProviderBase {
  readonly id: string;
  readonly source: ParsedSource;
  readonly exportName: string;
  readonly declarationSource: GeneratedSourceReferenceModel;
  readonly provides: readonly LinkedSymbol[];
  readonly primary: boolean;
  readonly qualifiers: readonly QualifierModel[];
  readonly dependencies: DependencyModel[];
}

interface ClassProviderModel extends ProviderBase {
  readonly kind: "class";
  readonly startHook: boolean;
  readonly closeHook: boolean;
}

interface FactoryProviderModel extends ProviderBase {
  readonly kind: "factory";
  readonly dispose: boolean;
}

export type ProviderModel = ClassProviderModel | FactoryProviderModel;

export interface PendingDependency {
  readonly index: number;
  readonly linkedType: LinkedType;
  readonly sourceSpan: SourceSpan;
}

export interface ProviderDraft {
  readonly provider: ProviderModel;
  readonly pendingDependencies: readonly PendingDependency[];
}

export interface ExecutionPlansModel {
  readonly constructionOrder: readonly string[];
  readonly startActionOrder: readonly string[];
  readonly cleanupActionOrder: readonly string[];
}

export function providerId(fileId: string, exportName: string): string {
  return `${fileId}#${exportName}`;
}

export function reportUnsupportedType(
  diagnostics: CompilerDiagnostic[],
  symbol: LinkedSymbol,
  span: SourceSpan,
): void {
  diagnostics.push(
    diagnostic({
      code: "UNSUPPORTED_TYPE_DECLARATION",
      message: `${symbol.name} resolves to a declaration kind that Reforce cannot use as a Bean contract.`,
      sourceSpan: span,
      help: "Use a directly linked non-generic class or interface as the Bean contract.",
    }),
  );
}

export function sourceReference(span: SourceSpan): GeneratedSourceReferenceModel {
  return { file: span.fileId, start: { ...span.start }, end: { ...span.end } };
}
