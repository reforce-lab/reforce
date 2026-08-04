import type { SourceSpan } from "@/parser/source-location";

export const resolvedApplicationProjectBrand: unique symbol = Symbol("ResolvedApplicationProject");

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
  | "INVALID_COLLECTION_INJECTION"
  | "INVALID_REQUEST_SCOPE_DEPENDENCY"
  | "INVALID_CURRENT_INJECTION"
  | "REQUEST_DEPENDENCY_CYCLE"
  | "UNSUPPORTED_APPLICATION_CONTEXT_INJECTION"
  | "UNSUPPORTED_GENERIC_INTERFACE"
  | "INVALID_LIFECYCLE_DECLARATION"
  | "INVALID_DEFINE_APPLICATION"
  | "INVALID_CONFIG_PROPERTIES"
  | "DUPLICATE_CONFIG_PREFIX"
  | "INVALID_CONFIG_INJECTION"
  | "DUPLICATE_STARTER_REGISTRATION"
  | "STARTER_META_NOT_FOUND"
  | "INVALID_STARTER_META"
  | "UNSUPPORTED_STARTER_META_VERSION"
  | "STARTER_META_RUNTIME_MISMATCH"
  | "INVALID_LIBRARY_PACKAGE"
  | "UNSUPPORTED_LIBRARY_DECLARATION"
  | "LIBRARY_EXPORT_MISMATCH"
  | "MISSING_BEAN"
  | "AMBIGUOUS_BEAN"
  | "MULTIPLE_PRIMARY_BEANS"
  | "UNKNOWN_BEAN_QUALIFIER"
  | "DUPLICATE_BEAN_QUALIFIER"
  | "INVALID_BEAN_QUALIFIER"
  | "BEAN_ID_COLLISION";

export interface CompilerDiagnostic {
  readonly kind: "compiler";
  readonly code: CompilerDiagnosticCode;
  readonly severity: "error";
  readonly message: string;
  readonly sourceSpan?: SourceSpan;
  readonly related: readonly {
    readonly message: string;
    readonly sourceSpan?: SourceSpan;
  }[];
  readonly help?: string;
  readonly cause?: {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
  };
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

export interface CompilerWatchInputs {
  readonly fileDependencies: readonly string[];
  readonly contextDependencies: readonly string[];
  readonly missingDependencies: readonly string[];
}

export type ProjectResolutionResult =
  | {
      readonly status: "success";
      readonly project: ResolvedApplicationProject;
      readonly diagnostics: readonly [];
      readonly watchInputs: CompilerWatchInputs;
    }
  | {
      readonly status: "failure";
      readonly diagnostics: readonly [CompilerDiagnostic, ...CompilerDiagnostic[]];
      readonly watchInputs: CompilerWatchInputs;
    };

export interface CompileRequest {
  readonly project: ResolvedApplicationProject;
}

// 库模式（ADR 0004 决策 1/4，#120/#147）：reforce lib 复用流水线中段，不产执行计划与
// beans.ts/bootstrap.ts；产物是 meta JSON 与 ./reforce 注册 handle 两个文件面。写盘位置由
// 调用方（CLI/unplugin 插件）决定，exports subpath 是唯一契约。
export interface CompileLibraryRequest {
  readonly project: ResolvedApplicationProject;
}

export interface LibraryGeneratedFile {
  readonly path: "reforce-meta.json" | "reforce.d.ts" | "reforce.js";
  readonly content: string;
}

export type CompileLibraryResult =
  | {
      readonly status: "success";
      readonly diagnostics: readonly [];
      readonly packageName: string;
      readonly files: readonly LibraryGeneratedFile[];
      readonly watchInputs: CompilerWatchInputs;
    }
  | {
      readonly status: "failure";
      readonly diagnostics: readonly [CompilerDiagnostic, ...CompilerDiagnostic[]];
      readonly watchInputs: CompilerWatchInputs;
    };

export interface GeneratedFile {
  readonly path: "beans.ts" | "qualifiers.d.ts" | "manifest.json" | "bootstrap.ts";
  readonly content: string;
}

export type CompileResult =
  | {
      readonly status: "success";
      readonly diagnostics: readonly [];
      readonly files: readonly GeneratedFile[];
      readonly watchInputs: CompilerWatchInputs;
    }
  | {
      readonly status: "failure";
      readonly diagnostics: readonly [CompilerDiagnostic, ...CompilerDiagnostic[]];
      readonly watchInputs: CompilerWatchInputs;
    };
