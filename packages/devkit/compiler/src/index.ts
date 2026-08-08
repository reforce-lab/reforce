export type {
  CompileLibraryRequest,
  CompileLibraryResult,
  CompileRequest,
  CompileResult,
  CompilerDiagnostic,
  GeneratedFile,
  LibraryGeneratedFile,
  ProjectResolutionResult,
  ResolveProjectRequest,
} from "@/api";
export { createCompiler } from "@/create-compiler";
// 诊断构造口是公开的（#367）：CompilerDiagnostic 的形状是去重键的输入——orderDiagnostics 与
// normalizeRelated 都按 stableStructuralKey 去重，而它走 Object.keys，所以「哪些键在对象上」
// 直接决定两条诊断算不算同一条。手搓字面量的消费方（此前 cli 的 dev 闸门就是）一旦少写一个
// 键，就会与经工厂构造的同内容诊断错开键、在输出里出现两遍。构造口只此一个。
export { diagnostic } from "@/diagnostics";
export { type CompilerDiagnosticCode, compilerDiagnosticCodes } from "@/error-codes";
