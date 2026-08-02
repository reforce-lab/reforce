import { LRUCache } from "lru-cache";
import type {
  CompileRequest,
  CompileResult,
  ProjectResolutionResult,
  ResolvedApplicationProject,
  ResolveProjectRequest,
} from "@/api";
import { compile } from "@/compile";
import type { SourceFileIr } from "@/parser/source-ir";
import type { ProjectState } from "@/project/project-config";
import { resolveProject } from "@/project/resolve-project";

export function createCompiler(): Readonly<{
  resolveProject(request: ResolveProjectRequest): Promise<ProjectResolutionResult>;
  compile(request: CompileRequest): Promise<CompileResult>;
}> {
  const projects = new WeakMap<ResolvedApplicationProject, ProjectState>();
  const parseCache = new LRUCache<string, SourceFileIr>({ max: 512 });
  return Object.freeze({
    resolveProject(request: ResolveProjectRequest) {
      return resolveProject(request, ({ project, state }) => {
        projects.set(project, state);
      });
    },
    compile(request: CompileRequest) {
      return compile(request, projects.get(request.project), parseCache);
    },
  });
}
