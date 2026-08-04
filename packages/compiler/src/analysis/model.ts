import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { LinkedSymbol, LinkedType } from "@/linking/model";
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
  // 该边的契约符号：emission 用它写 type-only 类型标注（ADR 0004 决策 8，#120）。只进生成的
  // import type 与 resolve<T>() 标注，不进 manifest / 运行时 JSON——序列化前必须剥掉。
  readonly contract: LinkedSymbol;
}

// bean 的来源（ADR 0004，#120）：应用源集里的声明，或注册 starter 的 meta bean。starter bean 没有
// 应用内 span，诊断用 sourceText（包名/包内路径:行:列）文本定位，manifest 的 origin 也从这里来。
export type ProviderOriginModel =
  | { readonly kind: "application"; readonly source: ParsedSource }
  | {
      readonly kind: "starter";
      readonly origin: string;
      readonly runtimeExport: { readonly module: string; readonly export: string };
      readonly sourceText: string;
    };

export interface QualifierModel {
  readonly interfaceSymbol: LinkedSymbol;
  readonly member: string;
}

interface ProviderBase {
  readonly id: string;
  readonly origin: ProviderOriginModel;
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

// 配置类 provider（ADR 0005，#130）：class 身份即注入 token，与普通候选同表参选（本地恒胜、
// 可闭合 starter 开放边），但不进 constructionOrder——实例由启动期绑定 phase 先于一切 bean 构造。
export interface ConfigProviderModel extends ProviderBase {
  readonly kind: "config";
  readonly prefix: string;
}

export type ProviderModel = ClassProviderModel | FactoryProviderModel | ConfigProviderModel;
export type BeanProviderModel = ClassProviderModel | FactoryProviderModel;

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
