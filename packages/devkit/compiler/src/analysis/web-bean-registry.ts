import { type BeanRole, beanRoleSpecOf } from "@/analysis/bean-roles";
import type { ProviderModel } from "@/analysis/model";
import type { ClassRoleScan } from "@/analysis/web-decorators";
import {
  type ErrorHandlerAnalysisInputs,
  type ErrorHandlerInfo,
  registerErrorHandler,
} from "@/analysis/web-error-handlers";
import { type MiddlewareInfo, registerMiddleware } from "@/analysis/web-middleware";
import type { RouteThrownErrorModel } from "@/analysis/web-model";
import type { RouteMarkerDeclarationInfo } from "@/analysis/web-route-markers";
import { resolveThrowsDecorators, type ThrowsResolutionContext } from "@/analysis/web-throws";
import type { CompilerDiagnostic } from "@/api";
import { report } from "@/diagnostics";
import type { ProjectLinker } from "@/linking/project-linker";

// web bean 的第一遍登记（#363 独立成模块）：中间件与错误处理器要先有名录，@Use 与全局链
// 才有东西可查；一类多角色在这里拒绝。
//
// 它是 middleware / error-handlers / throws 三者的唯一汇合点，所以那三个模块之间不必互相
// 认识——它们各自只 import 更下层的 decorators 与 class-target。
interface WebBeanRegistry {
  readonly middlewareById: ReadonlyMap<string, MiddlewareInfo>;
  readonly errorHandlers: readonly ErrorHandlerInfo[];
}

const webRoles = [
  "controller",
  "middleware",
  "error-handler",
] as const satisfies readonly BeanRole[];

function scanRoles(scan: ClassRoleScan): readonly string[] {
  return webRoles
    .map((role) => beanRoleSpecOf(role).decorator)
    .filter((decorator) => (scan.web.get(decorator)?.length ?? 0) > 0);
}

// 类级 S3 装饰器的落位裁决(#275):@Throws 只在 @Middleware 类、@ResponseStatus 只在
// @ErrorHandler 类;@ResponseSchema 从不标类。落错位不静默(#54 纪律)。
function reportMisplacedClassDecorators(
  scan: ClassRoleScan,
  diagnostics: CompilerDiagnostic[],
): void {
  const isMiddleware = (scan.web.get("Middleware")?.length ?? 0) > 0;
  const isErrorHandler = (scan.web.get("ErrorHandler")?.length ?? 0) > 0;
  const throwsSpan = scan.web.get("Throws")?.at(0)?.span;
  if (throwsSpan !== undefined && !isMiddleware) {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      "Throws on a class needs @Middleware(); route handlers declare thrown errors on the method.",
      throwsSpan,
    );
  }
  const statusSpan = scan.web.get("ResponseStatus")?.at(0)?.span;
  if (statusSpan !== undefined && !isErrorHandler) {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      "ResponseStatus on a class needs @ErrorHandler(); route handlers declare it on the method.",
      statusSpan,
    );
  }
  const schemaSpan = scan.web.get("ResponseSchema")?.at(0)?.span;
  if (schemaSpan !== undefined) {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      "ResponseSchema cannot mark a class; declare it on the route handler method.",
      schemaSpan,
    );
  }
}

// 第一遍：中间件与错误处理器登记（@Use 与全局链要先有名录），并拒绝一类多角色。
export function registerWebBeans(
  scans: readonly ClassRoleScan[],
  providerById: ReadonlyMap<string, ProviderModel>,
  // marker 名录先于本遍建成：@Middleware({ requires: Marker }) 要在登记时就解析成 key（#380）。
  markers: ReadonlyMap<string, RouteMarkerDeclarationInfo>,
  analysis: ErrorHandlerAnalysisInputs,
  diagnostics: CompilerDiagnostic[],
): WebBeanRegistry {
  const middlewareById = new Map<string, MiddlewareInfo>();
  const errorHandlers: ErrorHandlerInfo[] = [];
  for (const scan of scans) {
    const roles = scanRoles(scan);
    if (roles.length > 1) {
      report(
        diagnostics,
        "INVALID_ROUTE_DECLARATION",
        `A class can play one web role, found: ${roles.join(", ")}.`,
        scan.declaration.span,
      );
      continue;
    }
    reportMisplacedClassDecorators(scan, diagnostics);
    registerMiddleware(scan, providerById, markers, analysis.linker, middlewareById, diagnostics);
    registerErrorHandler(scan, providerById, errorHandlers, analysis, diagnostics);
  }
  return { middlewareById, errorHandlers };
}

// @Throws 匹配的准备(#275):accepts 键表按分派序取首个(运行时赢家),中间件类级 @Throws
// 在处理器名录落定后统一解析。
export function prepareThrowsResolution(
  registry: WebBeanRegistry,
  orderedErrorHandlers: readonly ErrorHandlerInfo[],
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): {
  readonly throwsContext: ThrowsResolutionContext;
  readonly middlewareThrows: ReadonlyMap<string, readonly RouteThrownErrorModel[]>;
} {
  const handlersByAcceptKey = new Map<string, ErrorHandlerInfo>();
  for (const handler of orderedErrorHandlers) {
    if (handler.accepts !== undefined && !handlersByAcceptKey.has(handler.accepts.key)) {
      handlersByAcceptKey.set(handler.accepts.key, handler);
    }
  }
  const throwsContext: ThrowsResolutionContext = {
    linker,
    handlersByAcceptKey,
    orderedHandlers: orderedErrorHandlers,
    diagnostics,
  };
  const middlewareThrows = new Map<string, readonly RouteThrownErrorModel[]>();
  for (const middleware of registry.middlewareById.values()) {
    const resolved = resolveThrowsDecorators(
      middleware.ref.source,
      middleware.throwsDecorators,
      throwsContext,
    );
    middlewareThrows.set(middleware.beanId, resolved.throws);
  }
  return { throwsContext, middlewareThrows };
}
