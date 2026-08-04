import type {
  CompilerDiagnostic,
  createCompiler,
  ProjectResolutionResult,
} from "@reforce/compiler";
import type { ReportedDiagnostic } from "@/reporter";

// 对齐锚点（ADR 0009，#191）：诊断 wire shape 由 reporter 定义（ReportedDiagnostic），编译器
// 诊断必须结构性满足；两侧漂移时下一行的泛型约束在这唯一一处报错，而不是散落在各 report 调用点。
type Satisfies<T extends Shape, Shape> = T;
export type ReportedCompilerDiagnostic = Satisfies<CompilerDiagnostic, ReportedDiagnostic>;

export type Compiler = ReturnType<typeof createCompiler>;
export type ResolvedProject = Extract<
  ProjectResolutionResult,
  { readonly status: "success" }
>["project"];
export type CompilerWatchInputs = ProjectResolutionResult["watchInputs"];
