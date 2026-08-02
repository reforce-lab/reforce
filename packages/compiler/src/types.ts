import type { TsConfigJsonResolved } from "get-tsconfig";
import type { SourceSpan } from "./parser/source-location";

const resolvedApplicationProjectBrand: unique symbol = Symbol("ResolvedApplicationProject");

export type CompilerDiagnosticCode =
  | "PARSER_SYNTAX_ERROR"
  | "INVALID_PROJECT_DIRECTORY"
  | "PROJECT_CONFIG_NOT_FOUND"
  | "INVALID_PROJECT_CONFIG"
  | "UNSUPPORTED_PROJECT_CONFIG"
  | "PROJECT_CONFIG_CHANGED"
  | "PROJECT_SELECTION_OUTSIDE_BOUNDARY"
  | "UNSUPPORTED_MODULE_RESOLUTION"
  | "GENERATED_DECLARATIONS_NOT_INCLUDED"
  | "SOURCE_OUTSIDE_PROJECT_ROOT"
  | "INVALID_SOURCE_FILE_ID"
  | "SOURCE_FILE_ID_COLLISION"
  | "MODULE_RESOLUTION_FAILED"
  | "TYPE_LINK_FAILED"
  | "AMBIGUOUS_RE_EXPORT"
  | "UNSUPPORTED_MODULE_SYNTAX"
  | "UNSUPPORTED_TYPE_DECLARATION"
  | "INVALID_DECORATOR_USAGE"
  | "INVALID_INJECTABLE"
  | "INVALID_DEFINE_BEAN"
  | "UNSUPPORTED_INJECTION_TYPE"
  | "UNSUPPORTED_APPLICATION_CONTEXT_INJECTION"
  | "UNSUPPORTED_GENERIC_INTERFACE"
  | "INVALID_LIFECYCLE_DECLARATION"
  | "MISSING_BEAN"
  | "AMBIGUOUS_BEAN"
  | "MULTIPLE_PRIMARY_BEANS"
  | "UNKNOWN_BEAN_QUALIFIER"
  | "DUPLICATE_BEAN_QUALIFIER"
  | "INVALID_BEAN_QUALIFIER"
  | "BEAN_ID_COLLISION";

export interface DiagnosticRelatedInformation {
  readonly message: string;
  readonly sourceSpan?: SourceSpan;
}

export interface DiagnosticCause {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

export interface CompilerDiagnostic {
  readonly kind: "compiler";
  readonly code: CompilerDiagnosticCode;
  readonly severity: "error";
  readonly message: string;
  readonly sourceSpan?: SourceSpan;
  readonly related: readonly DiagnosticRelatedInformation[];
  readonly help?: string;
  readonly cause?: DiagnosticCause;
}

export interface ResolveProjectRequest {
  readonly projectDirectory: string;
  readonly tsconfigPath?: string;
}

export interface ResolvedApplicationProject {
  readonly projectRoot: string;
  readonly tsconfigPath: string;
  readonly [resolvedApplicationProjectBrand]: true;
}

export function createResolvedApplicationProject(input: {
  readonly projectRoot: string;
  readonly tsconfigPath: string;
}): ResolvedApplicationProject {
  return Object.freeze({
    ...input,
    [resolvedApplicationProjectBrand]: true as const,
  });
}

export interface CompilerWatchInputs {
  readonly fileDependencies: readonly string[];
  readonly contextDependencies: readonly string[];
  readonly missingDependencies: readonly string[];
}

export interface ResolveProjectSuccess {
  readonly status: "success";
  readonly project: ResolvedApplicationProject;
  readonly diagnostics: readonly [];
  readonly watchInputs: CompilerWatchInputs;
}

export interface ResolveProjectFailure {
  readonly status: "failure";
  readonly diagnostics: readonly [CompilerDiagnostic, ...CompilerDiagnostic[]];
  readonly watchInputs: CompilerWatchInputs;
}

export type ProjectResolutionResult = ResolveProjectSuccess | ResolveProjectFailure;

export interface CompileRequest {
  readonly project: ResolvedApplicationProject;
}

export interface GeneratedFile {
  readonly path: "beans.ts" | "qualifiers.d.ts" | "manifest.json" | "bootstrap.ts";
  readonly content: string;
}

export interface CompileSuccess {
  readonly status: "success";
  readonly diagnostics: readonly [];
  readonly files: readonly GeneratedFile[];
  readonly watchInputs: CompilerWatchInputs;
}

export interface CompileFailure {
  readonly status: "failure";
  readonly diagnostics: readonly [CompilerDiagnostic, ...CompilerDiagnostic[]];
  readonly watchInputs: CompilerWatchInputs;
}

export type CompileResult = CompileSuccess | CompileFailure;

export interface ProjectSnapshotEntry {
  readonly path: string;
  readonly realpath: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly sha256?: string;
}

export interface ProjectState {
  readonly parsedConfig: EffectiveProjectConfig;
  readonly snapshot: readonly ProjectSnapshotEntry[];
  readonly watchInputs: CompilerWatchInputs;
}

export interface EffectiveProjectConfig {
  readonly config: TsConfigJsonResolved;
  readonly fileNames: readonly string[];
}
