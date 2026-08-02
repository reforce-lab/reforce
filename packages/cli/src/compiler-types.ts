import type { createCompiler, ProjectResolutionResult } from "@reforce/compiler";

export type Compiler = ReturnType<typeof createCompiler>;
export type ResolvedProject = Extract<
  ProjectResolutionResult,
  { readonly status: "success" }
>["project"];
export type CompilerWatchInputs = ProjectResolutionResult["watchInputs"];
