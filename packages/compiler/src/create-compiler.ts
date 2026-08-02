import { LRUCache } from "lru-cache";
import { compileProject } from "./compile-project";
import type { SourceUnit } from "./parser/source-ir";
import { resolveProject } from "./project/resolve-project";
import type {
  CompileRequest,
  CompileResult,
  ProjectResolutionResult,
  ProjectState,
  ResolvedApplicationProject,
  ResolveProjectRequest,
} from "./types";

export function createCompiler(): Readonly<{
  resolveProject(request: ResolveProjectRequest): Promise<ProjectResolutionResult>;
  compile(request: CompileRequest): Promise<CompileResult>;
}> {
  const projects = new WeakMap<ResolvedApplicationProject, ProjectState>();
  const parseCache = new LRUCache<string, SourceUnit>({ max: 512 });
  return Object.freeze({
    resolveProject(request: ResolveProjectRequest) {
      return resolveProject(request, ({ project, state }) => {
        projects.set(project, state);
      });
    },
    compile(request: CompileRequest) {
      return compileProject(request, projects.get(request.project), parseCache);
    },
  });
}
