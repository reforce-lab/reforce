import { compareUtf16CodeUnits } from "@reforce/primitives";
import type {
  RouteContractModel,
  RouteMetaValueModel,
  RouteModel,
  RouteSlotModel,
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

// routes.json 的 contract 节(#274):键名、契约来源(type/schema+vendor)与字段表全量落盘,
// `reforce explain routes` 的键名打印与后续 OpenAPI 导出都吃这份纯数据。
function contractManifestOf(
  contract: RouteContractModel,
  generatedDirectory: string,
): Record<string, unknown> {
  const slots = contract.slots.map((slot) => {
    if (isBareSlot(slot)) {
      return { slot: slot.kind };
    }
    const source =
      slot.contractSource.source === "schema"
        ? {
            source: "schema",
            schema: {
              moduleSpecifier: runtimeSpecifier(
                generatedDirectory,
                slot.contractSource.ref.source.absolutePath,
              ),
              exportName: slot.contractSource.ref.exportName,
            },
            ...(slot.contractSource.vendor === undefined
              ? {}
              : { vendor: slot.contractSource.vendor }),
          }
        : { source: "type" };
    return {
      slot: slot.kind,
      ...(slot.key === undefined ? {} : { key: slot.key }),
      ...(slot.kind === "body" ? {} : { form: slot.form }),
      source,
      table: slot.table,
    };
  });
  // v2 中间态(#275 M2):free-form 暂并入 passthrough——v2 闭集只有 table|passthrough,
  // 三变体的 manifest 形状随 schemaVersion 3 落地。
  const response =
    contract.response.kind === "table"
      ? { kind: "table", table: contract.response.table }
      : { kind: "passthrough" };
  return { slots, response };
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
    contract: contractManifestOf(route.contract, generatedDirectory),
    source: route.source,
  }));
  const errorHandlers = web.errorHandlers.map((handler) => ({
    beanId: handler.beanId,
    order: handler.order,
  }));
  return `${json({ schemaVersion: 2, routes, errorHandlers })}\n`;
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
  readonly encode: string | undefined;
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
  let encode: string | undefined;
  if (contract.response.kind === "table") {
    encode = `webEncode${String(routeIndex)}`;
    declarations.push(renderResponseEncoder(encode, contract.response.table));
  }
  const usesContext = contract.slots.some(isBareSlot);
  const usesSlots = contract.slots.some((slot) => !isBareSlot(slot));
  const argumentTexts = contract.slots.map((slot, index) => slotArgumentText(slot, index));
  const contextParameter = usesContext ? "context" : "_context";
  const slotsParameter = usesSlots ? "slots" : "_slots";
  const invoke = `(instance: InstanceType<typeof ${controllerAlias}>, ${contextParameter}: RequestContext, ${slotsParameter}: readonly unknown[]) => instance.${route.handler}(${argumentTexts.join(", ")})`;
  const slotsBlock = entries.length === 0 ? "[]" : `[\n${entries.join("\n")}\n    ]`;
  return { declarations, slotsBlock, invoke, encode };
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
    ...(slotRendering.encode === undefined ? [] : [`    encode: ${slotRendering.encode},`]),
    "  },",
  ].join("\n");
}

function renderRouteModule(web: WebModel, generatedDirectory: string): string {
  if (web.routes.length === 0 && web.errorHandlers.length === 0) {
    // 空表不 import：没有 web 内容的应用不需要安装 @reforce/web 也要能编译与 typecheck。
    return `export const routeTable = {\n  schemaVersion: 2,\n  routes: [],\n  errorHandlers: [],\n} as const;\n`;
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
  const moduleDeclarations: string[] = [];
  const routes = web.routes.map((route, routeIndex) =>
    renderRouteEntry(route, beanImports, schemaImports, routeIndex, moduleDeclarations),
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
    ...[...beanImports.values(), ...schemaImports.values()].map(
      (entry) =>
        `import { ${entry.ref.exportName} as ${entry.alias} } from ${JSON.stringify(entry.specifier)};`,
    ),
  ];
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
  const preamble = moduleDeclarations.length === 0 ? [] : [decoderPreamble];
  return `${[
    ...imports,
    "",
    ...preamble,
    ...moduleDeclarations.flatMap((declaration) => [declaration, ""]),
    "export const routeTable = {",
    "  schemaVersion: 2,",
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
