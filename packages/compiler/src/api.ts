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
  | "INVALID_ROUTE_DECLARATION"
  | "DUPLICATE_ROUTE"
  | "INVALID_ROUTE_MARKER"
  | "INVALID_ROUTE_MARKER_VALUE"
  | "INVALID_ROUTE_SCHEMA"
  | "INVALID_MIDDLEWARE_DECLARATION"
  | "INVALID_METHOD_MARKER"
  | "INVALID_METHOD_MARKER_VALUE"
  | "INVALID_TRANSACTIONAL_VALUE"
  | "INVALID_INTERCEPTOR_DECLARATION"
  | "INVALID_WEB_REQUEST_SEEDER"
  | "DUPLICATE_STARTER_REGISTRATION"
  | "STARTER_META_NOT_FOUND"
  | "INVALID_STARTER_META"
  | "UNSUPPORTED_STARTER_META_VERSION"
  | "STARTER_META_RUNTIME_MISMATCH"
  | "INVALID_LIBRARY_PACKAGE"
  | "UNSUPPORTED_LIBRARY_DECLARATION"
  | "LIBRARY_EXPORT_MISMATCH"
  | "ROLE_BEAN_AS_DEPENDENCY"
  | "MISSING_BEAN"
  | "AMBIGUOUS_BEAN"
  | "MULTIPLE_PRIMARY_BEANS"
  | "UNKNOWN_BEAN_QUALIFIER"
  | "DUPLICATE_BEAN_QUALIFIER"
  | "INVALID_BEAN_QUALIFIER"
  | "BEAN_ID_COLLISION"
  // 抑制注释（RFC 0011 D7，#242）。两者都是 warning：抑制机制本身出问题不该拦住编译。
  | "UNUSED_SUPPRESSION"
  | "SUPPRESSION_NOT_APPLICABLE";

export interface CompilerDiagnostic {
  readonly kind: "compiler";
  readonly code: CompilerDiagnosticCode;
  // warning 与 error 的区别不是「多严重」，而是「图完不完整」（RFC 0011 OM2，#242）：error 意味着
  // 分析结果不足以发射生成物，warning 意味着结果完整、只是有话要说。所以 warning 随 success 一起
  // 返回，而 status 只看有没有 error。
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly sourceSpan?: SourceSpan;
  readonly related: readonly {
    readonly message: string;
    readonly sourceSpan?: SourceSpan;
  }[];
  readonly help?: string;
  // 机器可读的修复建议（RFC 0011 D4，#242）。只定字段、只渲染，不做应用器：改写用户源码是
  // 另一个主题。结构必须是纯 plain 值——determinism 的 stableStructuralKey 不处理 Date/Map/Set，
  // 遇到会退化成 {}，让两条不同的建议算出同一个 key。
  readonly suggestions?: readonly {
    readonly message: string;
    readonly span: SourceSpan;
    readonly replacement: string;
    readonly applicability: "machine-applicable" | "maybe-incorrect" | "has-placeholders";
  }[];
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
      readonly diagnostics: readonly CompilerDiagnostic[];
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
// beans.ts/bootstrap.ts；产物只有 meta JSON 这一个文件面——注册 handle 由包作者用
// defineStarter() 手写在主入口，不再生成。写盘位置由调用方（CLI/unplugin 插件）决定，
// exports subpath 是唯一契约。
export interface CompileLibraryRequest {
  readonly project: ResolvedApplicationProject;
}

export interface LibraryGeneratedFile {
  readonly path: "reforce-meta.json";
  readonly content: string;
}

export type CompileLibraryResult =
  | {
      readonly status: "success";
      readonly diagnostics: readonly CompilerDiagnostic[];
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
  // routes.* 是第二种生成物（ADR 0006 W1，#152）：与 DI 四件套一起无条件产出精确全集——
  // CLI 的 generated 事务按全集校验落盘，无 web 内容时是零 import 的空表。
  readonly path:
    | "beans.ts"
    | "bootstrap.ts"
    | "manifest.json"
    | "qualifiers.d.ts"
    | "routes.json"
    | "routes.ts"
    | "weaving.json";
  readonly content: string;
}

export type CompileResult =
  | {
      readonly status: "success";
      // 成功不再等于零诊断（RFC 0011 OM2，#242）：这里的诊断全是 warning，error 一条都不会有。
      readonly diagnostics: readonly CompilerDiagnostic[];
      readonly files: readonly GeneratedFile[];
      readonly watchInputs: CompilerWatchInputs;
    }
  | {
      readonly status: "failure";
      readonly diagnostics: readonly [CompilerDiagnostic, ...CompilerDiagnostic[]];
      readonly watchInputs: CompilerWatchInputs;
    };
