import { compareUtf16CodeUnits } from "@reforce/primitives";
import type {
  ContractSourceModel,
  ResponseContractModel,
  RouteContractModel,
  RouteMetaValueModel,
  RouteModel,
  RouteSlotModel,
  WebErrorHandlerModel,
  WebExportRefModel,
  WebModel,
} from "@/analysis/web-model";
import type { GeneratedFile, ResolvedApplicationProject } from "@/api";
import { inlineJson, json, runtimeSpecifier } from "@/emission/render";
import { contractTypeText } from "@/emission/render-contract-type";
import {
  decoderPreamble,
  renderBodyDecoder,
  renderStringSlotDecoder,
} from "@/emission/render-decoders";
import { renderResponseEncoder } from "@/emission/render-encoders";
import { generatedDirectoryPath } from "@/project/generated-paths";

// 路由表生成物（ADR 0006 W1/W2，#142 / #152）双写：routes.json 是可 diff 的纯数据面
// （稳定序列化，schema 引用以生成目录视角的 module specifier 落盘），routes.ts 是可执行表
// （import 真实类与 schema 值，invoke 闭包让 tsc 背书 handler 契约——typed-edge 纪律的 web 面）。
// 两个文件无条件产出：CLI 的 generated 事务按精确全集校验，无 web 内容即零 import 空表。

export const webRuntimeModuleSpecifier = "@reforce/web/generated-runtime";

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

// 槽位契约里 typeof 追溯命中的用户 schema(#274):routes.ts 按坐标重新 import,解码交给它。
function contractSchemaRefs(contract: RouteContractModel): readonly WebExportRefModel[] {
  return contract.slots.flatMap((slot) => {
    if (isBareSlot(slot)) {
      return [];
    }
    return slot.contractSource.source === "schema" ? [slot.contractSource.ref] : [];
  });
}

function metaRecord(
  meta: ReadonlyMap<string, RouteMetaValueModel>,
): Record<string, RouteMetaValueModel> {
  return Object.fromEntries(
    [...meta.entries()].toSorted((left, right) => compareUtf16CodeUnits(left[0], right[0])),
  );
}

function isBareSlot(
  slot: RouteSlotModel,
): slot is Extract<
  RouteSlotModel,
  { readonly kind: "request" | "requestContext" | "responseHeaders" }
> {
  return (
    slot.kind === "request" || slot.kind === "requestContext" || slot.kind === "responseHeaders"
  );
}

function contractSourceManifestOf(
  source: ContractSourceModel,
  generatedDirectory: string,
): Record<string, unknown> {
  if (source.source !== "schema") {
    return { source: "type" };
  }
  return {
    source: "schema",
    schema: {
      moduleSpecifier: runtimeSpecifier(generatedDirectory, source.ref.source.absolutePath),
      exportName: source.ref.exportName,
    },
    ...(source.vendor === undefined ? {} : { vendor: source.vendor }),
  };
}

// 处理器响应的 manifest 形状(#275):errors 条目与顶层 errorHandlers 共用。passthrough
// (直返 Response)没有静态可知的状态码与形状,两键都缺席。
function handlerBodyManifestOf(
  response: ResponseContractModel,
): Record<string, unknown> | undefined {
  if (response.kind === "table") {
    return { kind: "table", table: response.table };
  }
  if (response.kind === "free-form") {
    return { kind: "free-form" };
  }
  return undefined;
}

// routes.json 的 contract 节(#274/#275):键名、契约来源(type/schema+vendor)、字段表与
// 响应三变体全量落盘,`reforce explain routes` 与 `reforce openapi` 都吃这份纯数据。
function contractManifestOf(
  route: RouteModel,
  handlersByBeanId: ReadonlyMap<string, WebErrorHandlerModel>,
  generatedDirectory: string,
): Record<string, unknown> {
  const contract = route.contract;
  const slots = contract.slots.map((slot) => {
    if (isBareSlot(slot)) {
      return { slot: slot.kind };
    }
    return {
      slot: slot.kind,
      ...(slot.key === undefined ? {} : { key: slot.key }),
      ...(slot.kind === "body" ? {} : { form: slot.form }),
      source: contractSourceManifestOf(slot.contractSource, generatedDirectory),
      // manifest 落线上侧表(#310):schema 槽的输入侧可缺省合并进根字段 optional;
      // routes.ts 的 typed-edge 仍用 handler 侧的 slot.table。
      table: slot.wireTable ?? slot.table,
    };
  });
  // errors = @Throws 并集(路由 ∪ 挂载中间件,分析层已按类键去重、错误名排序):
  // - handler 变体携带分派赢家处理器的 beanId 与其声明的状态码/形状(passthrough 处理器
  //   两者缺席);
  // - http-error 变体(defineHttpError 造的异常,#310)无处理器,运行时兜底闭集直译
  //   problem+json,status/code 是 defineHttpError 实参的静态字面量(非字面量时缺席)。
  const errors = route.throws.map((thrown) => {
    if (thrown.kind === "http-error") {
      return {
        error: thrown.errorName,
        ...(thrown.status === undefined ? {} : { status: thrown.status }),
        body: { kind: "problem", ...(thrown.code === undefined ? {} : { code: thrown.code }) },
      };
    }
    const handler = handlersByBeanId.get(thrown.handlerBeanId);
    const body = handler === undefined ? undefined : handlerBodyManifestOf(handler.response);
    const status = handler?.response.status;
    return {
      error: thrown.errorName,
      handler: thrown.handlerBeanId,
      ...(status === undefined ? {} : { status }),
      ...(body === undefined ? {} : { body }),
    };
  });
  const response = {
    kind: contract.response.kind,
    ...(contract.response.status === undefined ? {} : { status: contract.response.status }),
    ...(contract.response.kind === "table"
      ? {
          table: contract.response.table,
          source: contractSourceManifestOf(contract.response.contractSource, generatedDirectory),
        }
      : {}),
    ...(errors.length === 0 ? {} : { errors }),
  };
  return { slots, response };
}

function renderRouteManifest(web: WebModel, generatedDirectory: string): string {
  const handlersByBeanId = new Map(web.errorHandlers.map((handler) => [handler.beanId, handler]));
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
    contract: contractManifestOf(route, handlersByBeanId, generatedDirectory),
    source: route.source,
  }));
  const errorHandlers = web.errorHandlers.map((handler) => {
    const status = handler.response.status;
    const body = handlerBodyManifestOf(handler.response);
    return {
      beanId: handler.beanId,
      order: handler.order,
      ...(handler.accepts === undefined
        ? {}
        : {
            accepts: {
              name: handler.accepts.name,
              moduleSpecifier: runtimeSpecifier(
                generatedDirectory,
                handler.accepts.ref.source.absolutePath,
              ),
            },
          }),
      ...(status === undefined ? {} : { status }),
      ...(body === undefined ? {} : { body }),
    };
  });
  return `${json({ schemaVersion: 4, routes, errorHandlers })}\n`;
}

const bareSlotArguments = {
  request: "context.request",
  requestContext: "context",
  responseHeaders: "context.responseHeaders",
} as const;

interface SlotRouteRendering {
  // 模块级解码器/编码器常量声明,先于 routeTable 发射。
  readonly declarations: readonly string[];
  readonly slotsBlock: string;
  readonly invoke: string;
  readonly responseText: string;
}

// 槽位路由的 invoke(#274 typed-edge):slots 第三参按参数序,数据槽经渲染的契约类型文本
// 一次 as 断言(运行时解码器已兑现该类型),裸槽从 context 取,第四档投影键在此展开。
function slotArgumentText(slot: RouteSlotModel, index: number): string {
  if (isBareSlot(slot)) {
    return bareSlotArguments[slot.kind];
  }
  let typeText = contractTypeText(slot.table);
  if (slot.kind !== "body" && slot.form === "optional-single") {
    typeText = `${typeText} | undefined`;
  }
  if (slot.key !== undefined && (slot.kind === "body" || slot.form === "contract")) {
    return `(slots[${String(index)}] as ${typeText})[${JSON.stringify(slot.key)}]`;
  }
  return `slots[${String(index)}] as ${typeText}`;
}

function slotEntryText(
  route: RouteModel,
  slot: RouteSlotModel,
  index: number,
  schemaImports: ReadonlyMap<string, WebValueImport>,
  routeIndex: number,
  declarations: string[],
): string {
  if (isBareSlot(slot)) {
    return `      { slot: ${JSON.stringify(slot.kind)} },`;
  }
  const keyField = slot.key === undefined ? "" : ` key: ${JSON.stringify(slot.key)},`;
  if (slot.contractSource.source === "schema") {
    const alias = schemaImports.get(importKey(slot.contractSource.ref))?.alias;
    if (alias === undefined) {
      throw new Error(`Missing slot schema import for route ${route.method} ${route.path}`);
    }
    return `      { slot: ${JSON.stringify(slot.kind)},${keyField} schema: ${alias} },`;
  }
  const decoderName = `webDecode${String(routeIndex)}_${String(index)}`;
  declarations.push(
    slot.kind === "body"
      ? renderBodyDecoder(decoderName, slot)
      : renderStringSlotDecoder(decoderName, slot),
  );
  return `      { slot: ${JSON.stringify(slot.kind)},${keyField} decode: ${decoderName} },`;
}

// 响应三变体的表达式文本(#275):table 携带本路由的白名单编码器常量。
function responseEntryText(
  response: ResponseContractModel,
  routeIndex: number,
  declarations: string[],
): string {
  if (response.kind === "table") {
    const encode = `webEncode${String(routeIndex)}`;
    declarations.push(renderResponseEncoder(encode, response.table));
    return `{ kind: "table", status: ${String(response.status)}, encode: ${encode} }`;
  }
  if (response.kind === "free-form") {
    return `{ kind: "free-form", status: ${String(response.status)} }`;
  }
  return response.status === undefined
    ? '{ kind: "passthrough" }'
    : `{ kind: "passthrough", status: ${String(response.status)} }`;
}

function renderSlotRoute(
  route: RouteModel,
  contract: RouteContractModel,
  controllerAlias: string,
  schemaImports: ReadonlyMap<string, WebValueImport>,
  routeIndex: number,
): SlotRouteRendering {
  const declarations: string[] = [];
  const entries = contract.slots.map((slot, index) =>
    slotEntryText(route, slot, index, schemaImports, routeIndex, declarations),
  );
  const responseText = responseEntryText(contract.response, routeIndex, declarations);
  const usesContext = contract.slots.some(isBareSlot);
  const usesSlots = contract.slots.some((slot) => !isBareSlot(slot));
  const argumentTexts = contract.slots.map((slot, index) => slotArgumentText(slot, index));
  const contextParameter = usesContext ? "context" : "_context";
  const slotsParameter = usesSlots ? "slots" : "_slots";
  const invoke = `(instance: InstanceType<typeof ${controllerAlias}>, ${contextParameter}: RequestContext, ${slotsParameter}: readonly unknown[]) => instance.${route.handler}(${argumentTexts.join(", ")})`;
  const slotsBlock = entries.length === 0 ? "[]" : `[\n${entries.join("\n")}\n    ]`;
  return { declarations, slotsBlock, invoke, responseText };
}

function renderRouteEntry(
  route: RouteModel,
  beanImports: ReadonlyMap<string, WebValueImport>,
  schemaImports: ReadonlyMap<string, WebValueImport>,
  routeIndex: number,
  moduleDeclarations: string[],
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
  const middlewareBlock = middleware.length === 0 ? "[]" : `[\n${middleware.join("\n")}\n    ]`;
  const slotRendering = renderSlotRoute(
    route,
    route.contract,
    controllerAlias,
    schemaImports,
    routeIndex,
  );
  moduleDeclarations.push(...slotRendering.declarations);
  return [
    "  {",
    `    method: ${JSON.stringify(route.method)},`,
    `    path: ${JSON.stringify(route.path)},`,
    `    controller: ${controllerAlias},`,
    `    beanId: ${JSON.stringify(route.controllerId)},`,
    `    handler: ${JSON.stringify(route.handler)},`,
    `    invoke: ${slotRendering.invoke},`,
    `    middleware: ${middlewareBlock},`,
    `    meta: ${inlineJson(metaRecord(route.meta), 4)},`,
    `    slots: ${slotRendering.slotsBlock},`,
    `    response: ${slotRendering.responseText},`,
    "  },",
  ].join("\n");
}

// 类型化错误处理器条目(#275):accepts 类经第三 import 组(webError 前缀)进 instanceof 闸,
// table 契约的编码器复用路由同款 renderResponseEncoder。
function renderErrorHandlerEntry(
  handler: WebErrorHandlerModel,
  handlerIndex: number,
  beanImports: ReadonlyMap<string, WebValueImport>,
  errorImports: ReadonlyMap<string, WebValueImport>,
  moduleDeclarations: string[],
): string {
  const alias = beanImports.get(importKey(handler.ref))?.alias;
  if (alias === undefined) {
    throw new Error(`Missing error handler import for ${handler.beanId}`);
  }
  const fields = [
    `bean: ${alias}`,
    `beanId: ${JSON.stringify(handler.beanId)}`,
    `order: ${String(handler.order)}`,
  ];
  if (handler.accepts !== undefined) {
    const acceptsAlias = errorImports.get(importKey(handler.accepts.ref))?.alias;
    if (acceptsAlias === undefined) {
      throw new Error(`Missing accepts import for ${handler.beanId}`);
    }
    fields.push(`accepts: ${acceptsAlias}`);
  }
  if (handler.response.status !== undefined) {
    fields.push(`status: ${String(handler.response.status)}`);
  }
  if (handler.response.kind === "table") {
    const encode = `webErrorEncode${String(handlerIndex)}`;
    moduleDeclarations.push(renderResponseEncoder(encode, handler.response.table));
    fields.push(`encode: ${encode}`);
  }
  return `  { ${fields.join(", ")} },`;
}

function renderRouteModule(web: WebModel, generatedDirectory: string): string {
  if (web.routes.length === 0 && web.errorHandlers.length === 0) {
    // 空表不 import：没有 web 内容的应用不需要安装 @reforce/web 也要能编译与 typecheck。
    return `export const routeTable = {\n  schemaVersion: 4,\n  routes: [],\n  errorHandlers: [],\n} as const;\n`;
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
    web.routes.flatMap((route) => [...contractSchemaRefs(route.contract)]),
    generatedDirectory,
    "webSchema",
  );
  const errorImports = collectImports(
    web.errorHandlers.flatMap((handler) =>
      handler.accepts === undefined ? [] : [handler.accepts.ref],
    ),
    generatedDirectory,
    "webError",
  );
  const moduleDeclarations: string[] = [];
  const routes = web.routes.map((route, routeIndex) =>
    renderRouteEntry(route, beanImports, schemaImports, routeIndex, moduleDeclarations),
  );
  const errorHandlers = web.errorHandlers.map((handler, handlerIndex) =>
    renderErrorHandlerEntry(handler, handlerIndex, beanImports, errorImports, moduleDeclarations),
  );
  // StandardSchemaV1 只在真的发射了解码器常量(带该标注)时 import:多余的 type import
  // 会撞上用户项目的 noUnusedLocals;纯编码器路由不需要它。
  const needsStandardSchema = moduleDeclarations.some((declaration) =>
    declaration.includes(": StandardSchemaV1"),
  );
  const runtimeTypes = needsStandardSchema
    ? "GeneratedRouteTable, RequestContext, StandardSchemaV1"
    : "GeneratedRouteTable, RequestContext";
  const imports = [
    `import type { ${runtimeTypes} } from "${webRuntimeModuleSpecifier}";`,
    ...[...beanImports.values(), ...schemaImports.values(), ...errorImports.values()].map(
      (entry) =>
        `import { ${entry.ref.exportName} as ${entry.alias} } from ${JSON.stringify(entry.specifier)};`,
    ),
  ];
  const routesBlock = routes.length === 0 ? "routes: []," : `routes: [\n${routes.join("\n")}\n  ],`;
  const errorHandlersBlock =
    errorHandlers.length === 0
      ? "errorHandlers: [],"
      : `errorHandlers: [\n${errorHandlers.join("\n")}\n  ],`;
  const preamble = moduleDeclarations.length === 0 ? [] : [decoderPreamble];
  return `${[
    ...imports,
    "",
    ...preamble,
    ...moduleDeclarations.flatMap((declaration) => [declaration, ""]),
    "export const routeTable = {",
    "  schemaVersion: 4,",
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
