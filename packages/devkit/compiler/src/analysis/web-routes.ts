import { compareUtf16CodeUnits, toCanonicalPathKey } from "@reforce/primitives";
import { type ProviderModel, sourceReference } from "@/analysis/model";
import { prepareThrowsResolution, registerWebBeans } from "@/analysis/web-bean-registry";
import {
  type ClassRoleScan,
  claimWebBean,
  responseSchemaOf,
  responseStatusOf,
  scanWebClasses,
  singleCalledDecorator,
  type WebBeanClaim,
  webDecoratorsOf,
} from "@/analysis/web-decorators";
import { flattenedChain, type MiddlewareInfo, useTargetsOf } from "@/analysis/web-middleware";
import {
  emptyWebModel,
  type RouteContractModel,
  type RouteMetaValueModel,
  type RouteMiddlewareModel,
  type RouteThrownErrorModel,
  type WebEngineModel,
  type WebErrorHandlerModel,
  type WebExportRefModel,
  type WebModel,
} from "@/analysis/web-model";
import {
  collectRouteMarkers,
  type RouteMarkerDeclarationInfo,
  routeMetaOf,
} from "@/analysis/web-route-markers";
import {
  normalizedPrefix,
  type RouteCandidate,
  reportRouteConflicts,
  routeDecoratorNames,
  routeMethodByDecorator,
  routePathOf,
  validRouteHandlerMethod,
} from "@/analysis/web-route-path";
import { createSlotResolutionContext } from "@/analysis/web-slot-context";
import {
  type ResponseDirectives,
  reportUnknownPathParameters,
  resolveRouteSlots,
} from "@/analysis/web-slots";
import {
  resolveThrowsDecorators,
  type ThrowsResolutionContext,
  unionThrows,
} from "@/analysis/web-throws";
import type { CompilerDiagnostic } from "@/api";
import { report } from "@/diagnostics";
import type { ProjectLinker } from "@/linking/project-linker";
import type { StarterBeanModel } from "@/linking/starter-linking";
import type { ClassMethodDeclaration, DecoratorUse } from "@/parser/source-ir";
import type { ParsedSource } from "@/project/source-files";
import type { TypeQuery } from "@/typescript/type-query";

// web 路由分析的顶层遍历与接线（ADR 0006 W1/W3/W4/W5，#142 / #152）：controller/中间件/
// 错误处理器都是 bean，身份由各自的角色装饰器蕴含（bean-roles.ts）。这里静态提取路由表：
// 路径归并与冲突检测、marker 字面量提取、槽位契约解析(RFC 0012 S2,#274)、中间件链按
// (阶段, order, beanId) 压平写死。
//
// 具体每一件事的实现已经按单向分层拆到同目录的 web-* 里（#363）：class-target ← decorators
// ← {route-markers, route-path} ← {error-handlers ← throws, middleware} ← bean-registry ←
// 本文件。本文件只留遍历顺序与接线，不再重复任何一层的判定。

// 引擎与播种接线（ADR 0006 W2 的 #153 修订，约定见 web-model.ts）：引擎排序按 beanId 决定
// 性决胜；webRequestSeeder 在 defineApplication 模块作用域内解析，未导出是硬错——生成的
// bootstrap 必须能 import 它，类型契约（RequestSeeder）由生成代码上的 tsc 背书（typed-edge）。
function webWiring(
  linker: ProjectLinker,
  engineBeans: readonly StarterBeanModel[],
  diagnostics: CompilerDiagnostic[],
): { engines: readonly WebEngineModel[]; requestSeeder?: WebExportRefModel } {
  const engines = engineBeans
    .map((bean) => ({
      beanId: bean.id,
      moduleSpecifier: bean.runtimeExport.module,
      exportName: bean.runtimeExport.export,
    }))
    .toSorted((left, right) => compareUtf16CodeUnits(left.beanId, right.beanId));
  const applicationModule = linker.applicationModule;
  if (engines.length === 0 || applicationModule === undefined) {
    return { engines };
  }
  const seeder = linker.resolveValueDeclaration(applicationModule, "webRequestSeeder");
  if (seeder === undefined) {
    return { engines };
  }
  if (seeder.exportName === undefined) {
    report(
      diagnostics,
      "INVALID_WEB_REQUEST_SEEDER",
      "webRequestSeeder must be an exported declaration so the generated bootstrap can import it.",
      seeder.declaration.span,
    );
    return { engines };
  }
  return {
    engines,
    requestSeeder: { source: seeder.source, exportName: seeder.exportName },
  };
}

export function analyzeWebRoutes(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
  providers: readonly ProviderModel[],
  diagnostics: CompilerDiagnostic[],
  engineBeans: readonly StarterBeanModel[],
  typeQuery?: TypeQuery,
): WebModel {
  const scans = scanWebClasses(sources, linker);
  const markers = collectRouteMarkers(sources, linker, diagnostics);
  const wiring = webWiring(linker, engineBeans, diagnostics);
  if (scans.length === 0 && markers.size === 0 && wiring.engines.length === 0) {
    return emptyWebModel;
  }

  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const fileIdBySourcePath = new Map(
    sources.map((source) => [toCanonicalPathKey(source.absolutePath), source.fileId as string]),
  );
  const fileIdOf = (declarationPath: string): string | undefined =>
    fileIdBySourcePath.get(toCanonicalPathKey(declarationPath));
  const registry = registerWebBeans(
    scans,
    providerById,
    { linker, typeQuery, fileIdOf },
    diagnostics,
  );
  const globalMiddleware = [...registry.middlewareById.values()]
    .filter((middleware) => middleware.global)
    .toSorted((left, right) => compareUtf16CodeUnits(left.beanId, right.beanId));

  // 处理器先按分派序排定(#275):@Throws 的 manifest 绑定要指向运行时会赢的那个处理器,
  // 同 accepts 键的多个处理器由 (order, beanId) 决胜。
  const orderedErrorHandlers = registry.errorHandlers.toSorted((left, right) => {
    const order = left.order - right.order;
    return order === 0 ? compareUtf16CodeUnits(left.beanId, right.beanId) : order;
  });
  const { throwsContext, middlewareThrows } = prepareThrowsResolution(
    registry,
    orderedErrorHandlers,
    linker,
    diagnostics,
  );

  const context: WebAnalysisContext = {
    linker,
    typeQuery,
    fileIdOf,
    providerById,
    middlewareById: registry.middlewareById,
    globalMiddleware,
    markers,
    throwsContext,
    middlewareThrows,
    diagnostics,
  };
  const candidates: RouteCandidate[] = [];
  for (const scan of scans) {
    collectControllerRoutes(context, scan, candidates);
  }

  const routes = reportRouteConflicts(candidates, diagnostics).toSorted((left, right) => {
    const path = compareUtf16CodeUnits(left.path, right.path);
    return path === 0 ? compareUtf16CodeUnits(left.method, right.method) : path;
  });
  return {
    routes: Object.freeze(routes),
    errorHandlers: Object.freeze(
      orderedErrorHandlers.map(({ span: _span, ...model }): WebErrorHandlerModel => model),
    ),
    engines: Object.freeze(wiring.engines),
    ...(wiring.requestSeeder === undefined ? {} : { requestSeeder: wiring.requestSeeder }),
  };
}

// 一次 analyzeWebRoutes 内恒定的那部分（#363）：linker、名录、诊断桶这十项每个 controller、
// 每个 handler、每条路由都要用，此前和 per-scan 的三项（scan / controllerDecorator /
// allowRoutes）与出参 candidates 混在同一个 inputs 里逐层传，看不出哪些随遍历变化。
interface WebAnalysisContext {
  readonly linker: ProjectLinker;
  readonly typeQuery: TypeQuery | undefined;
  readonly fileIdOf: (declarationPath: string) => string | undefined;
  readonly providerById: ReadonlyMap<string, ProviderModel>;
  readonly middlewareById: ReadonlyMap<string, MiddlewareInfo>;
  readonly globalMiddleware: readonly MiddlewareInfo[];
  readonly markers: ReadonlyMap<string, RouteMarkerDeclarationInfo>;
  readonly throwsContext: ThrowsResolutionContext;
  readonly middlewareThrows: ReadonlyMap<string, readonly RouteThrownErrorModel[]>;
  readonly diagnostics: CompilerDiagnostic[];
}

// 单个 controller 类内恒定的那部分：allowRoutes 决定这个类的方法算不算路由，claim 与
// basePath 是每条路由都要挂上去的两个值，use 是类级 @Use 解析出来的中间件。
interface ControllerContext {
  readonly scan: ClassRoleScan;
  readonly name: string;
  readonly allowRoutes: boolean;
  readonly claim: WebBeanClaim | undefined;
  readonly basePath: string | undefined;
  readonly use: readonly MiddlewareInfo[];
}

function controllerBasePath(
  decorator: DecoratorUse | undefined,
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  if (decorator === undefined) {
    return "";
  }
  const argument = decorator.arguments.at(0);
  if (argument === undefined) {
    return "";
  }
  if (decorator.arguments.length !== 1 || argument.kind !== "string-literal") {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      "Controller accepts one string literal base path.",
      argument.span,
    );
    return undefined;
  }
  return normalizedPrefix(argument.value, argument.span, diagnostics);
}

// 方法位合法集合:路由装饰器、@Use 与三个响应侧装饰器(#275);其余 web 装饰器落方法即硬错。
const methodLevelDecoratorNames = new Set(["Use", "ResponseStatus", "ResponseSchema", "Throws"]);

function reportMisplacedMethodDecorators(
  methodWeb: ReadonlyMap<string, readonly DecoratorUse[]>,
  method: ClassMethodDeclaration,
  diagnostics: CompilerDiagnostic[],
): void {
  for (const [name, decorators] of methodWeb.entries()) {
    if (routeDecoratorNames.has(name) || methodLevelDecoratorNames.has(name)) {
      continue;
    }
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `${name} cannot mark a method.`,
      decorators.at(0)?.span ?? method.span,
    );
  }
}

// controllerDecorator 与 allowRoutes 就地从 scan.web 现算：诊断顺序不变——非 controller 类
// 的 "Controller" 装饰器数组是空的，singleCalledDecorator 对空数组静默返回。
function controllerContextOf(context: WebAnalysisContext, scan: ClassRoleScan): ControllerContext {
  const { diagnostics } = context;
  const controllerDecorator = singleCalledDecorator(
    "Controller",
    scan.web.get("Controller") ?? [],
    "INVALID_ROUTE_DECLARATION",
    diagnostics,
  );
  const isController = (scan.web.get("Controller")?.length ?? 0) > 0;
  const isOtherRole =
    (scan.web.get("Middleware")?.length ?? 0) > 0 ||
    (scan.web.get("ErrorHandler")?.length ?? 0) > 0;
  const allowRoutes = isController && !isOtherRole;
  return {
    scan,
    name: scan.declaration.name ?? "an anonymous class",
    allowRoutes,
    claim: allowRoutes
      ? claimWebBean(scan.source, scan.declaration, "controller", context.providerById, diagnostics)
      : undefined,
    basePath: allowRoutes
      ? controllerBasePath(isController ? controllerDecorator : undefined, diagnostics)
      : undefined,
    use: useTargetsOf(
      scan.source,
      scan.web.get("Use") ?? [],
      context.middlewareById,
      context.linker,
      diagnostics,
    ),
  };
}

function collectControllerRoutes(
  context: WebAnalysisContext,
  scan: ClassRoleScan,
  candidates: RouteCandidate[],
): void {
  const controller = controllerContextOf(context, scan);
  if (!controller.allowRoutes && (scan.web.get("Use")?.length ?? 0) > 0) {
    report(
      context.diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `Use on ${controller.name} needs a @Controller class: only controllers mount route middleware.`,
      scan.declaration.span,
    );
  }
  for (const method of scan.declaration.methods) {
    collectMethodRoutes(context, controller, method, candidates);
  }
}

// S3 响应侧装饰器(#275):三者的语法解析先于槽位解析,任何一处失败都弃整个方法——
// 半套指令继续解析只会产出互相矛盾的诊断(与旧 schemas 实参同一口径)。
function routeResponseDirectivesOf(
  source: ParsedSource,
  methodWeb: ReadonlyMap<string, readonly DecoratorUse[]>,
  context: WebAnalysisContext,
  diagnostics: CompilerDiagnostic[],
):
  | {
      readonly response: ResponseDirectives;
      readonly throws: readonly RouteThrownErrorModel[];
    }
  | undefined {
  const parsedStatus = responseStatusOf(methodWeb.get("ResponseStatus") ?? [], diagnostics);
  const parsedSchema = responseSchemaOf(methodWeb.get("ResponseSchema") ?? [], diagnostics);
  const methodThrows = resolveThrowsDecorators(
    source,
    methodWeb.get("Throws") ?? [],
    context.throwsContext,
  );
  if (parsedStatus.failed || parsedSchema.failed || methodThrows.failed) {
    return undefined;
  }
  return {
    response: {
      ...(parsedStatus.status === undefined ? {} : { status: parsedStatus.status }),
      ...(parsedSchema.schema === undefined ? {} : { schema: parsedSchema.schema }),
    },
    throws: methodThrows.throws,
  };
}

// @Use 与三个响应侧装饰器都要求同方法上有路由装饰器,落空即点名(#54 纪律,不静默)。
function reportOrphanMethodDirectives(
  methodWeb: ReadonlyMap<string, readonly DecoratorUse[]>,
  method: ClassMethodDeclaration,
  diagnostics: CompilerDiagnostic[],
): void {
  for (const name of methodLevelDecoratorNames) {
    if (methodWeb.has(name)) {
      report(
        diagnostics,
        "INVALID_ROUTE_DECLARATION",
        `${name} on a method requires a route decorator on the same method.`,
        methodWeb.get(name)?.at(0)?.span ?? method.span,
      );
    }
  }
}

// 旧 `@Get(path, schemas)` 链路已随 RFC 0012 S2 删除(#274 终态):第二实参一律迁移硬错,
// 整方法不再进任何分析路径——槽位契约与它表达的是同一份事实,带着旧实参继续解析只会
// 产出两套互相矛盾的诊断。
function reportLegacySchemaArguments(
  routeDecorators: readonly (readonly [string, readonly DecoratorUse[]])[],
  diagnostics: CompilerDiagnostic[],
): boolean {
  const schemaArguments = routeDecorators.flatMap(([, decorators]) =>
    decorators.filter((decorator) => decorator.arguments.length > 1),
  );
  for (const decorator of schemaArguments) {
    report(
      diagnostics,
      "INVALID_ROUTE_SCHEMA",
      "Route decorators no longer accept a schemas argument.",
      decorator.arguments.at(1)?.span ?? decorator.span,
      {
        help: "Declare inputs as typed handler parameters (Body/Param/Query/Header, RFC 0012); a Standard Schema keeps driving decoding when the parameter type traces to it via typeof.",
      },
    );
  }
  return schemaArguments.length > 0;
}

function collectMethodRoutes(
  context: WebAnalysisContext,
  controller: ControllerContext,
  method: ClassMethodDeclaration,
  candidates: RouteCandidate[],
): void {
  const { scan, name: controllerName, claim, basePath } = controller;
  const { diagnostics } = context;
  const methodWeb = webDecoratorsOf(scan.source, method.decorators, context.linker);
  const routeDecorators = [...methodWeb.entries()].filter(([name]) =>
    routeDecoratorNames.has(name),
  );
  reportMisplacedMethodDecorators(methodWeb, method, diagnostics);
  if (routeDecorators.length === 0) {
    reportOrphanMethodDirectives(methodWeb, method, diagnostics);
    return;
  }
  if (!controller.allowRoutes) {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `Route decorators on ${controllerName} need a @Controller class.`,
      routeDecorators[0]?.[1][0]?.span ?? method.span,
    );
    return;
  }
  if (claim === undefined || basePath === undefined) {
    return;
  }
  if (reportLegacySchemaArguments(routeDecorators, diagnostics)) {
    return;
  }
  const handlerName = validRouteHandlerMethod(method, controllerName, diagnostics);
  if (handlerName === undefined) {
    return;
  }
  const directives = routeResponseDirectivesOf(scan.source, methodWeb, context, diagnostics);
  if (directives === undefined) {
    return;
  }
  const contract = resolveRouteSlots({
    method,
    controllerName,
    context: createSlotResolutionContext({
      source: scan.source,
      method,
      linker: context.linker,
      query: context.typeQuery,
      fileIdOf: context.fileIdOf,
      diagnostics,
    }),
    responseDirectives: directives.response,
  });
  if (contract === undefined) {
    return;
  }
  const routeUse = useTargetsOf(
    scan.source,
    methodWeb.get("Use") ?? [],
    context.middlewareById,
    context.linker,
    diagnostics,
  );
  const middleware = flattenedChain(context.globalMiddleware, controller.use, routeUse);
  const throws = unionThrows([
    directives.throws,
    ...middleware.map((entry) => context.middlewareThrows.get(entry.beanId) ?? []),
  ]);
  pushRouteCandidates(
    scan.source,
    routeDecorators,
    {
      basePath,
      claim,
      handlerName,
      contract,
      throws,
      middleware,
      meta: routeMetaOf(scan.source, method, context.markers, context.linker, diagnostics),
    },
    candidates,
    diagnostics,
  );
}

// 一条路由要挂上去的、per-method 已经定好的那份值。routeDecorators 不在里面：一个方法可以
// 带多个路由装饰器，它是遍历的对象而不是路由自己的属性。
interface RouteDraft {
  readonly basePath: string;
  readonly claim: WebBeanClaim;
  readonly handlerName: string;
  readonly contract: RouteContractModel;
  readonly throws: readonly RouteThrownErrorModel[];
  readonly middleware: readonly RouteMiddlewareModel[];
  readonly meta: ReadonlyMap<string, RouteMetaValueModel>;
}

function pushRouteCandidates(
  source: ParsedSource,
  routeDecorators: readonly (readonly [string, readonly DecoratorUse[]])[],
  draft: RouteDraft,
  candidates: RouteCandidate[],
  diagnostics: CompilerDiagnostic[],
): void {
  for (const [decoratorName, decorators] of routeDecorators) {
    for (const decorator of decorators) {
      const route = routeOf(source, decoratorName, decorator, draft, diagnostics);
      if (route !== undefined) {
        candidates.push(route);
      }
    }
  }
}

function routeSubPathOf(
  decoratorName: string,
  decorator: DecoratorUse,
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  const pathArgument = decorator.arguments.at(0);
  if (pathArgument === undefined) {
    return "";
  }
  if (pathArgument.kind !== "string-literal") {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `${decoratorName} path must be a string literal.`,
      pathArgument.span,
    );
    return undefined;
  }
  return normalizedPrefix(pathArgument.value, pathArgument.span, diagnostics);
}

function routeOf(
  source: ParsedSource,
  decoratorName: string,
  decorator: DecoratorUse,
  draft: RouteDraft,
  diagnostics: CompilerDiagnostic[],
): RouteCandidate | undefined {
  if (!decorator.called || decorator.arguments.length > 1) {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `${decoratorName} must be called with an optional path literal.`,
      decorator.span,
    );
    return undefined;
  }
  const subPath = routeSubPathOf(decoratorName, decorator, diagnostics);
  if (subPath === undefined) {
    return undefined;
  }
  const pathInfo = routePathOf(draft.basePath, subPath, decorator.span, diagnostics);
  if (pathInfo === undefined) {
    return undefined;
  }
  // 硬错 6(#274)按路由复裁:同方法多路由装饰器时各自的路径参数集不同,槽位解析本身
  // per-method 只跑一次。
  if (
    !reportUnknownPathParameters(draft.contract, pathInfo.path, pathInfo.parameters, diagnostics)
  ) {
    return undefined;
  }
  // 名字表驱动：routeDecoratorNames 已经证明成员资格，索引推不回值联合
  // // justified: 见上一行
  const method = routeMethodByDecorator[decoratorName as keyof typeof routeMethodByDecorator];
  return {
    route: {
      method,
      path: pathInfo.path,
      controller: draft.claim.ref,
      controllerId: draft.claim.beanId,
      handler: draft.handlerName,
      middleware: draft.middleware,
      meta: draft.meta,
      contract: draft.contract,
      throws: draft.throws,
      source: sourceReference(decorator.span),
    },
    shapeKey: pathInfo.shapeKey,
    span: decorator.span,
    fileId: source.fileId,
  };
}
