import { compareUtf16CodeUnits } from "@reforce/primitives";
import type {
  RouteMetaValueModel,
  RouteModel,
  RouteSchemasModel,
  WebExportRefModel,
  WebModel,
} from "@/analysis/web-model";
import type { GeneratedFile, ResolvedApplicationProject } from "@/api";
import { inlineJson, json, runtimeSpecifier } from "@/emission/render";
import { generatedDirectoryPath } from "@/project/generated-paths";

// 路由表生成物（ADR 0006 W1/W2，#142 / #152）双写：routes.json 是可 diff 的纯数据面
// （稳定序列化，schema 引用以生成目录视角的 module specifier 落盘），routes.ts 是可执行表
// （import 真实类与 schema 值，invoke 闭包让 tsc 背书 handler 契约——typed-edge 纪律的 web 面）。
// 两个文件无条件产出：CLI 的 generated 事务按精确全集校验，无 web 内容即零 import 空表。

export const webRuntimeModuleSpecifier = "@reforce/web/generated-runtime";

const schemaSlots = ["params", "query", "body", "response"] as const;

interface WebValueImport {
  readonly ref: WebExportRefModel;
  readonly specifier: string;
  readonly alias: string;
}

function importKey(ref: WebExportRefModel): string {
  return `${ref.source.fileId}\0${ref.exportName}`;
}

function collectImports(
  refs: readonly WebExportRefModel[],
  generatedDirectory: string,
  aliasPrefix: string,
): ReadonlyMap<string, WebValueImport> {
  const byKey = new Map<string, { ref: WebExportRefModel; specifier: string }>();
  for (const ref of refs) {
    const key = importKey(ref);
    if (!byKey.has(key)) {
      byKey.set(key, {
        ref,
        specifier: runtimeSpecifier(generatedDirectory, ref.source.absolutePath),
      });
    }
  }
  const ordered = [...byKey.entries()].toSorted((left, right) => {
    const specifier = compareUtf16CodeUnits(left[1].specifier, right[1].specifier);
    if (specifier !== 0) {
      return specifier;
    }
    const name = compareUtf16CodeUnits(left[1].ref.exportName, right[1].ref.exportName);
    return name === 0 ? compareUtf16CodeUnits(left[0], right[0]) : name;
  });
  return new Map(
    ordered.map(([key, entry], index) => [
      key,
      { ref: entry.ref, specifier: entry.specifier, alias: `${aliasPrefix}${index}` },
    ]),
  );
}

function schemaRefs(schemas: RouteSchemasModel): readonly WebExportRefModel[] {
  return schemaSlots.flatMap((slot) => {
    const ref = schemas[slot];
    return ref === undefined ? [] : [ref];
  });
}

function metaRecord(
  meta: ReadonlyMap<string, RouteMetaValueModel>,
): Record<string, RouteMetaValueModel> {
  return Object.fromEntries(
    [...meta.entries()].toSorted((left, right) => compareUtf16CodeUnits(left[0], right[0])),
  );
}

function renderRouteManifest(web: WebModel, generatedDirectory: string): string {
  const routes = web.routes.map((route) => ({
    method: route.method,
    path: route.path,
    controller: {
      beanId: route.controllerId,
      handler: route.handler,
      moduleSpecifier: runtimeSpecifier(generatedDirectory, route.controller.source.absolutePath),
      exportName: route.controller.exportName,
    },
    middleware: route.middleware.map((middleware) => ({
      beanId: middleware.beanId,
      phase: middleware.phase,
      order: middleware.order,
      mount: middleware.mount,
    })),
    meta: metaRecord(route.meta),
    schemas: Object.fromEntries(
      schemaSlots.flatMap((slot) => {
        const ref = route.schemas[slot];
        return ref === undefined
          ? []
          : [
              [
                slot,
                {
                  moduleSpecifier: runtimeSpecifier(generatedDirectory, ref.source.absolutePath),
                  exportName: ref.exportName,
                },
              ] as const,
            ];
      }),
    ),
    source: route.source,
  }));
  const errorHandlers = web.errorHandlers.map((handler) => ({
    beanId: handler.beanId,
    order: handler.order,
  }));
  return `${json({ schemaVersion: 1, routes, errorHandlers })}\n`;
}

// handler 声明的是 RequestContext<S>，S 由本路由的 schema 决定；基类型的 params 是
// unknown，赋不进 { id: bigint }。所以闭包参数要带上本路由的具体 schema 类型——生成物
// 已经 import 了 schema 值，这里按 typeof 拼回类型。GeneratedRoute.invoke 是方法语法
// 声明（双变参数，见 route-table.ts），带具体类型的闭包装进 GeneratedRoute<object>
// 数组仍可赋值，与 controller 类型走同一个机制。
function requestContextType(
  route: RouteModel,
  schemaImports: ReadonlyMap<string, WebValueImport>,
): string {
  const slots = schemaSlots.flatMap((slot) => {
    const ref = route.schemas[slot];
    if (ref === undefined) {
      return [];
    }
    const alias = schemaImports.get(importKey(ref))?.alias;
    if (alias === undefined) {
      throw new Error(`Missing schema import for route ${route.method} ${route.path}`);
    }
    return [`${slot}: typeof ${alias}`];
  });
  return slots.length === 0 ? "RequestContext" : `RequestContext<{ ${slots.join("; ")} }>`;
}

function invokeExpression(
  route: RouteModel,
  controllerAlias: string,
  schemaImports: ReadonlyMap<string, WebValueImport>,
): string {
  const call =
    route.handlerArity === 0 ? `instance.${route.handler}()` : `instance.${route.handler}(context)`;
  // typed-edge（ADR 0004 决策 8 的 web 面）：闭包实参类型让 tsc 背书 handler 方法存在、
  // 可用本路由的 RequestContext 调用；运行时只以本路由的 controller 实例调用。
  return `(instance: InstanceType<typeof ${controllerAlias}>, context: ${requestContextType(route, schemaImports)}) => ${call}`;
}

function renderRouteEntry(
  route: RouteModel,
  beanImports: ReadonlyMap<string, WebValueImport>,
  schemaImports: ReadonlyMap<string, WebValueImport>,
): string {
  const controllerAlias = beanImports.get(importKey(route.controller))?.alias;
  if (controllerAlias === undefined) {
    throw new Error(`Missing controller import for ${route.controllerId}`);
  }
  const middleware = route.middleware.map((entry) => {
    const alias = beanImports.get(importKey(entry.ref))?.alias;
    if (alias === undefined) {
      throw new Error(`Missing middleware import for ${entry.beanId}`);
    }
    return `      { bean: ${alias}, beanId: ${JSON.stringify(entry.beanId)}, phase: ${JSON.stringify(entry.phase)}, order: ${String(entry.order)}, mount: ${JSON.stringify(entry.mount)} },`;
  });
  const schemas = schemaSlots.flatMap((slot) => {
    const ref = route.schemas[slot];
    if (ref === undefined) {
      return [];
    }
    const alias = schemaImports.get(importKey(ref))?.alias;
    if (alias === undefined) {
      throw new Error(`Missing schema import for route ${route.method} ${route.path}`);
    }
    return [`${slot}: ${alias}`];
  });
  const middlewareBlock = middleware.length === 0 ? "[]" : `[\n${middleware.join("\n")}\n    ]`;
  return [
    "  {",
    `    method: ${JSON.stringify(route.method)},`,
    `    path: ${JSON.stringify(route.path)},`,
    `    controller: ${controllerAlias},`,
    `    beanId: ${JSON.stringify(route.controllerId)},`,
    `    handler: ${JSON.stringify(route.handler)},`,
    `    invoke: ${invokeExpression(route, controllerAlias, schemaImports)},`,
    `    middleware: ${middlewareBlock},`,
    `    meta: ${inlineJson(metaRecord(route.meta), 4)},`,
    `    schemas: { ${schemas.join(", ")} },`,
    "  },",
  ].join("\n");
}

function renderRouteModule(web: WebModel, generatedDirectory: string): string {
  if (web.routes.length === 0 && web.errorHandlers.length === 0) {
    // 空表不 import：没有 web 内容的应用不需要安装 @reforce/web 也要能编译与 typecheck。
    return `export const routeTable = {\n  schemaVersion: 1,\n  routes: [],\n  errorHandlers: [],\n} as const;\n`;
  }
  const beanImports = collectImports(
    [
      ...web.routes.flatMap((route) => [
        route.controller,
        ...route.middleware.map((middleware) => middleware.ref),
      ]),
      ...web.errorHandlers.map((handler) => handler.ref),
    ],
    generatedDirectory,
    "webTarget",
  );
  const schemaImports = collectImports(
    web.routes.flatMap((route) => schemaRefs(route.schemas)),
    generatedDirectory,
    "webSchema",
  );
  const imports = [
    `import type { GeneratedRouteTable, RequestContext } from "${webRuntimeModuleSpecifier}";`,
    ...[...beanImports.values(), ...schemaImports.values()].map(
      (entry) =>
        `import { ${entry.ref.exportName} as ${entry.alias} } from ${JSON.stringify(entry.specifier)};`,
    ),
  ];
  const routes = web.routes.map((route) => renderRouteEntry(route, beanImports, schemaImports));
  const errorHandlers = web.errorHandlers.map((handler) => {
    const alias = beanImports.get(importKey(handler.ref))?.alias;
    if (alias === undefined) {
      throw new Error(`Missing error handler import for ${handler.beanId}`);
    }
    return `  { bean: ${alias}, beanId: ${JSON.stringify(handler.beanId)}, order: ${String(handler.order)} },`;
  });
  const routesBlock = routes.length === 0 ? "routes: []," : `routes: [\n${routes.join("\n")}\n  ],`;
  const errorHandlersBlock =
    errorHandlers.length === 0
      ? "errorHandlers: [],"
      : `errorHandlers: [\n${errorHandlers.join("\n")}\n  ],`;
  return `${[
    ...imports,
    "",
    "export const routeTable = {",
    "  schemaVersion: 1,",
    `  ${routesBlock}`,
    `  ${errorHandlersBlock}`,
    "} as const satisfies GeneratedRouteTable;",
  ].join("\n")}\n`;
}

export function generateWebFiles(
  project: ResolvedApplicationProject,
  web: WebModel,
): readonly GeneratedFile[] {
  const generatedDirectory = generatedDirectoryPath(project.projectRoot);
  return [
    { path: "routes.json", content: renderRouteManifest(web, generatedDirectory) },
    { path: "routes.ts", content: renderRouteModule(web, generatedDirectory) },
  ];
}
