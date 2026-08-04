import { LRUCache } from "lru-cache";
import type {
  CompileLibraryRequest,
  CompileLibraryResult,
  CompileRequest,
  CompileResult,
  ProjectResolutionResult,
  ResolvedApplicationProject,
  ResolveProjectRequest,
} from "@/api";
import { compile } from "@/compile";
import { compileLibrary } from "@/library/compile";
import type { SourceFileIr } from "@/parser/source-ir";
import type { ProjectState } from "@/project/project-config";
import { resolveProject } from "@/project/resolve-project";

export function createCompiler(): Readonly<{
  resolveProject(request: ResolveProjectRequest): Promise<ProjectResolutionResult>;
  compile(request: CompileRequest): Promise<CompileResult>;
  resolveLibraryProject(request: ResolveProjectRequest): Promise<ProjectResolutionResult>;
  compileLibrary(request: CompileLibraryRequest): Promise<CompileLibraryResult>;
}> {
  // 应用与库项目分表登记：库项目跳过 .reforce/generated include 闸门（#147），把它误交给
  // compile() 时状态查不到，走 PROJECT_CONFIG_CHANGED 失败而不是继续按应用语义编译；反向同理。
  const projects = new WeakMap<ResolvedApplicationProject, ProjectState>();
  const libraryProjects = new WeakMap<ResolvedApplicationProject, ProjectState>();
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
    resolveLibraryProject(request: ResolveProjectRequest) {
      return resolveProject(
        request,
        ({ project, state }) => {
          libraryProjects.set(project, state);
        },
        false,
      );
    },
    compileLibrary(request: CompileLibraryRequest) {
      return compileLibrary(request, libraryProjects.get(request.project), parseCache);
    },
  });
}
