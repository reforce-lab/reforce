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

export function sourceReference(span: SourceSpan): GeneratedSourceReferenceModel {
  return {
    file: span.fileId,
    start: {
      offset: span.start.offset,
      line: span.start.line,
      character: span.start.character,
    },
    end: {
      offset: span.end.offset,
      line: span.end.line,
      character: span.end.character,
    },
  };
}
