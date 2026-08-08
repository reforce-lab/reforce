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
import { createCheckerSession } from "@/typescript/checker-session";

export function createCompiler(): Readonly<{
  resolveProject(request: ResolveProjectRequest): Promise<ProjectResolutionResult>;
  compile(request: CompileRequest): Promise<CompileResult>;
  resolveLibraryProject(request: ResolveProjectRequest): Promise<ProjectResolutionResult>;
  compileLibrary(request: CompileLibraryRequest): Promise<CompileLibraryResult>;
  close(): void;
}> {
  // 应用与库项目分表登记：库项目跳过 .reforce/generated include 闸门（#147），把它误交给
  // compile() 时状态查不到，走 PROJECT_CONFIG_CHANGED 失败而不是继续按应用语义编译；反向同理。
  const projects = new WeakMap<ResolvedApplicationProject, ProjectState>();
  const libraryProjects = new WeakMap<ResolvedApplicationProject, ProjectState>();
  const parseCache = new LRUCache<string, SourceFileIr>({ max: 512 });
  // checker 会话与 parseCache 同级(RFC 0012 S1,#273):dev-watch 每轮 compileNext 都会新建
  // ProjectState,挂在那里会导致每次改动重 spawn tsgo;挂编译器实例级才能跨 compile 复用
  // snapshot。会话懒 spawn,不消费 checker 的编译不为它付进程成本。
  const checkerSession = createCheckerSession();
  return Object.freeze({
    resolveProject(request: ResolveProjectRequest) {
      return resolveProject(request, ({ project, state }) => {
        projects.set(project, state);
      });
    },
    compile(request: CompileRequest) {
      return compile(request, projects.get(request.project), parseCache, checkerSession);
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
    close() {
      checkerSession.close();
    },
  });
}
