import { compileProject } from "./compile-project";
import { createParseCache } from "./incremental/parse-cache";
import { resolveProject } from "./project/resolve-project";
import type {
  CompileRequest,
  Compiler,
  ProjectState,
  ResolvedApplicationProject,
  ResolveProjectRequest,
} from "./types";

export function createCompiler(): Compiler {
  const projects = new WeakMap<ResolvedApplicationProject, ProjectState>();
  const parseCache = createParseCache();
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
