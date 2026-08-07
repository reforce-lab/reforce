import { compareUtf16CodeUnits } from "@reforce/primitives";
import { type BeanRole, beanRoleSpecOf, claimRoleBean } from "@/analysis/bean-roles";
import { type ProviderModel, providerId, sourceReference } from "@/analysis/model";
import {
  emptyWebModel,
  type HttpMethodModel,
  type MiddlewareMountModel,
  type RouteContractModel,
  type RouteMetaValueModel,
  type RouteMiddlewareModel,
  type RouteModel,
  type RouteSchemasModel,
  type WebEngineModel,
  type WebErrorHandlerModel,
  type WebExportRefModel,
  type WebModel,
  type WebPhaseModel,
  webPhaseOrder,
  webPhaseRank,
} from "@/analysis/web-model";
import { createSlotResolutionContext } from "@/analysis/web-slot-context";
import { reportUnknownPathParameters, resolveRouteSlots } from "@/analysis/web-slots";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { ProjectLinker } from "@/linking/project-linker";
import type { StarterBeanModel } from "@/linking/starter-linking";
import type {
  ClassDeclaration,
  ClassMethodDeclaration,
  DecoratorArgumentValue,
  DecoratorUse,
  ObjectLiteralProperty,
  ValueDeclaration,
} from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";
import type { TypeQuery } from "@/typescript/type-query";

// web 路由分析（ADR 0006 W1/W3/W4/W5，#142 / #152）：controller/中间件/错误处理器都是 bean，
// 身份由各自的角色装饰器蕴含（bean-roles.ts）。这里静态提取路由表：路径归并与冲突检测、
// marker 字面量提取、schema 引用核实、中间件链按 (阶段, order, beanId) 压平写死。

const routeMethodByDecorator = {
  Delete: "DELETE",
  Get: "GET",
  Head: "HEAD",
  Options: "OPTIONS",
  Patch: "PATCH",
  Post: "POST",
  Put: "PUT",
} as const satisfies Record<string, HttpMethodModel>;

const routeDecoratorNames = new Set(Object.keys(routeMethodByDecorator));

const parameterSegmentPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const literalSegmentPattern = /^[A-Za-z0-9._~-]+$/;

const markerDeclarationHelp =
  'Declare route markers as export const X = defineRouteMarker<T>("key") with a non-empty string literal key.';
const markerValueHelp =
  "Route marker values must be static JSON literals: string, number, boolean, null, array, or object literals.";
const schemaHelp =
  "Reference a top-level const exported from an application module; re-export chains and external packages are not supported.";

function report(
  diagnostics: CompilerDiagnostic[],
  code: CompilerDiagnostic["code"],
  message: string,
  span: SourceSpan,
  options: { readonly help?: string; readonly related?: CompilerDiagnostic["related"] } = {},
): void {
  diagnostics.push(
    diagnostic({
      code,
      message,
      sourceSpan: span,
      help: options.help,
      related: options.related,
    }),
  );
}

// coreDecorators 的 web 版：按解析后的符号名分组，别名照样命中，非 web 装饰器留给别人。
function webDecoratorsOf(
  source: ParsedSource,
  decorators: readonly DecoratorUse[],
  linker: ProjectLinker,
): ReadonlyMap<string, readonly DecoratorUse[]> {
  const result = new Map<string, DecoratorUse[]>();
  for (const decorator of decorators) {
    if (decorator.callee.kind === "unsupported-expression") {
      continue;
    }
    const symbol = linker.resolveEntity(source, decorator.callee);
    if (symbol?.kind !== "web") {
      continue;
    }
    const existing = result.get(symbol.name) ?? [];
    existing.push(decorator);
    result.set(symbol.name, existing);
  }
  return result;
}

interface RouteMarkerDeclarationInfo {
  readonly key: string;
  readonly span: SourceSpan;
}

interface CollectedRouteMarker {
  readonly registryKey: string;
  readonly fileId: string;
  readonly name: string;
  readonly info: RouteMarkerDeclarationInfo;
}

function markerRegistryKey(fileId: string, localName: string): string {
  return `${fileId}#${localName}`;
}

// marker 声明规则（ADR 0006 W3 待打磨项定案，#152）：顶层 const、直接调用 defineRouteMarker、
// key 是非空字符串字面量。命中 defineRouteMarker 但形状非法的声明原位硬错，不静默跳过（#54）。
function routeMarkerDeclarationOf(
  source: ParsedSource,
  declaration: ValueDeclaration,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): CollectedRouteMarker | undefined {
  const initializer = declaration.initializer;
  if (initializer?.kind !== "call") {
    return undefined;
  }
  const callee = linker.resolveEntity(source, initializer.callee);
  if (callee?.kind !== "web" || callee.name !== "defineRouteMarker") {
    return undefined;
  }
  if (
    !declaration.topLevel ||
    declaration.declarationKind !== "const" ||
    declaration.name === undefined
  ) {
    report(
      diagnostics,
      "INVALID_ROUTE_MARKER",
      "defineRouteMarker must initialize a top-level const with a single name.",
      declaration.span,
      { help: markerDeclarationHelp },
    );
    return undefined;
  }
  const argument = initializer.arguments.at(0);
  if (
    initializer.arguments.length !== 1 ||
    argument?.kind !== "string-literal" ||
    argument.value.length === 0
  ) {
    report(
      diagnostics,
      "INVALID_ROUTE_MARKER",
      `Route marker ${declaration.name} needs exactly one non-empty string literal key.`,
      argument?.span ?? initializer.span,
      { help: markerDeclarationHelp },
    );
    return undefined;
  }
  return {
    registryKey: markerRegistryKey(source.fileId, declaration.name),
    fileId: source.fileId,
    name: declaration.name,
    info: { key: argument.value, span: declaration.span },
  };
}

// key 空间是全局的（#254）：meta 表按裸字符串 key 存，两个声明撞 key 时互为别名，
// route.meta(A) 会取到 B 写入的值。排序让首见者与报错顺序确定；报错后注册表保留全部声明，
// 使用侧不再连带报错。
function reportDuplicateMarkerKeys(
  collected: readonly CollectedRouteMarker[],
  diagnostics: CompilerDiagnostic[],
): void {
  const firstByKey = new Map<string, CollectedRouteMarker>();
  const ordered = collected.toSorted((left, right) => {
    const file = compareUtf16CodeUnits(left.fileId, right.fileId);
    return file === 0 ? left.info.span.start.offset - right.info.span.start.offset : file;
  });
  for (const marker of ordered) {
    const first = firstByKey.get(marker.info.key);
    if (first === undefined) {
      firstByKey.set(marker.info.key, marker);
      continue;
    }
    report(
      diagnostics,
      "DUPLICATE_ROUTE_MARKER",
      `Route marker key ${JSON.stringify(marker.info.key)} is already declared by ${first.name}.`,
      marker.info.span,
      {
        help: "Give each route marker a globally unique key.",
        related: [{ message: first.name, sourceSpan: first.info.span }],
      },
    );
  }
}

function collectRouteMarkers(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): ReadonlyMap<string, RouteMarkerDeclarationInfo> {
  const collected: CollectedRouteMarker[] = [];
  for (const source of sources) {
    if (source.sourceKind.startsWith("d.")) {
      continue;
    }
    for (const declaration of source.unit.valueDeclarations) {
      const entry = routeMarkerDeclarationOf(source, declaration, linker, diagnostics);
      if (entry !== undefined) {
        collected.push(entry);
      }
    }
  }
  reportDuplicateMarkerKeys(collected, diagnostics);
  return new Map(collected.map((marker) => [marker.registryKey, marker.info]));
}

// marker 值 = JSON 字面量树（ADR 0006 W3 待打磨项定案）：静态可提取是硬边界，任何引用、
// 模板或计算形态原位点名拒绝。
function metaValueOf(
  value: DecoratorArgumentValue,
  diagnostics: CompilerDiagnostic[],
): RouteMetaValueModel | undefined {
  if (value.kind === "string-literal" || value.kind === "boolean-literal") {
    return value.value;
  }
  if (value.kind === "number-literal") {
    return metaNumberOf(value.value, value.span, diagnostics);
  }
  if (value.kind === "null-literal") {
    return null;
  }
  if (value.kind === "array-literal") {
    return metaArrayOf(value.elements, diagnostics);
  }
  if (value.kind === "object-literal") {
    return metaObjectOf(value.properties, diagnostics);
  }
  report(
    diagnostics,
    "INVALID_ROUTE_MARKER_VALUE",
    "Route marker values must be statically extractable literals.",
    value.span,
    { help: markerValueHelp },
  );
  return undefined;
}

function metaNumberOf(
  value: number,
  span: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): number | undefined {
  if (Number.isFinite(value)) {
    return value;
  }
  report(
    diagnostics,
    "INVALID_ROUTE_MARKER_VALUE",
    "Route marker numbers must be finite to serialize into the route table.",
    span,
    { help: markerValueHelp },
  );
  return undefined;
}

function metaArrayOf(
  elements: readonly DecoratorArgumentValue[],
  diagnostics: CompilerDiagnostic[],
): RouteMetaValueModel | undefined {
  const lowered: RouteMetaValueModel[] = [];
  for (const element of elements) {
    const value = metaValueOf(element, diagnostics);
    if (value === undefined) {
      return undefined;
    }
    lowered.push(value);
  }
  return lowered;
}

function metaObjectOf(
  properties: readonly ObjectLiteralProperty[],
  diagnostics: CompilerDiagnostic[],
): RouteMetaValueModel | undefined {
  const lowered: Record<string, RouteMetaValueModel> = {};
  for (const property of properties) {
    const entry = metaPropertyOf(property, diagnostics);
    if (entry === undefined) {
      return undefined;
    }
    lowered[entry.key] = entry.value;
  }
  return lowered;
}

function metaPropertyOf(
  property: ObjectLiteralProperty,
  diagnostics: CompilerDiagnostic[],
): { readonly key: string; readonly value: RouteMetaValueModel } | undefined {
  if (property.kind === "unsupported-property") {
    report(
      diagnostics,
      "INVALID_ROUTE_MARKER_VALUE",
      `Route marker objects cannot use ${property.propertyKind} properties.`,
      property.span,
      { help: markerValueHelp },
    );
    return undefined;
  }
  const value = metaValueOf(property.value, diagnostics);
  return value === undefined ? undefined : { key: property.key, value };
}

interface MiddlewareInfo {
  readonly ref: WebExportRefModel;
  readonly beanId: string;
  readonly phase: WebPhaseModel;
  readonly order: number;
  readonly global: boolean;
}

interface WebBeanClaim {
  readonly ref: WebExportRefModel;
  readonly beanId: string;
}

// controller/中间件/错误处理器的 bean 身份由各自的角色装饰器蕴含（bean-roles.ts）：身份、
// singleton 约束、@Injectable 共存拒绝都在 class-provider 一处判定，这里只把认领结果翻译成
// web 侧的引用形状。
function claimWebBean(
  source: ParsedSource,
  declaration: ClassDeclaration,
  role: BeanRole,
  providerById: ReadonlyMap<string, ProviderModel>,
  diagnostics: CompilerDiagnostic[],
): WebBeanClaim | undefined {
  const claim = claimRoleBean(source, declaration, role, providerById, diagnostics);
  if (claim === undefined) {
    return undefined;
  }
  return { ref: { source, exportName: claim.exportName }, beanId: claim.beanId };
}

function singleCalledDecorator(
  name: string,
  decorators: readonly DecoratorUse[],
  code: CompilerDiagnostic["code"],
  diagnostics: CompilerDiagnostic[],
): DecoratorUse | undefined {
  const first = decorators.at(0);
  if (first === undefined) {
    return undefined;
  }
  if (decorators.length !== 1 || !first.called) {
    report(diagnostics, code, `${name} must appear at most once as @${name}(...).`, first.span);
    return undefined;
  }
  return first;
}

interface MiddlewareOptionsModel {
  readonly phase: WebPhaseModel;
  readonly order: number;
  readonly global: boolean;
}

function isWebPhaseModel(value: string): value is WebPhaseModel {
  return (webPhaseOrder as readonly string[]).includes(value);
}

// 选项键表驱动（超过 3 分支的分派按仓库纪律归一为 key → 解析器）：parse 返回 undefined 即
// 值形态非法，message 是对应的点名文案。
const middlewareOptionParsers = {
  phase: {
    message: `Middleware phase must be one of ${webPhaseOrder
      .map((phase) => JSON.stringify(phase))
      .join(", ")}.`,
    parse: (value: DecoratorArgumentValue, options: MiddlewareOptionsModel) =>
      value.kind === "string-literal" && isWebPhaseModel(value.value)
        ? { ...options, phase: value.value }
        : undefined,
  },
  order: {
    message: "Middleware order must be an integer literal.",
    parse: (value: DecoratorArgumentValue, options: MiddlewareOptionsModel) =>
      value.kind === "number-literal" && Number.isInteger(value.value)
        ? { ...options, order: value.value }
        : undefined,
  },
  global: {
    message: "Middleware global must be a boolean literal.",
    parse: (value: DecoratorArgumentValue, options: MiddlewareOptionsModel) =>
      value.kind === "boolean-literal" ? { ...options, global: value.value } : undefined,
  },
} as const;

function middlewareOptionOf(
  property: ObjectLiteralProperty,
  options: MiddlewareOptionsModel,
  diagnostics: CompilerDiagnostic[],
): MiddlewareOptionsModel | undefined {
  if (property.kind === "unsupported-property") {
    report(
      diagnostics,
      "INVALID_MIDDLEWARE_DECLARATION",
      `Middleware options cannot use ${property.propertyKind} properties.`,
      property.span,
    );
    return undefined;
  }
  if (!Object.hasOwn(middlewareOptionParsers, property.key)) {
    report(
      diagnostics,
      "INVALID_MIDDLEWARE_DECLARATION",
      `Middleware options do not include "${property.key}".`,
      property.span,
    );
    return undefined;
  }
  // Object.hasOwn 已证明成员资格，索引签名推不回字面量联合 // justified: 见上一行
  const parser = middlewareOptionParsers[property.key as keyof typeof middlewareOptionParsers];
  const parsed = parser.parse(property.value, options);
  if (parsed === undefined) {
    report(diagnostics, "INVALID_MIDDLEWARE_DECLARATION", parser.message, property.span);
    return undefined;
  }
  return parsed;
}

function middlewareOptionsOf(
  decorator: DecoratorUse,
  diagnostics: CompilerDiagnostic[],
): MiddlewareOptionsModel | undefined {
  const defaults: MiddlewareOptionsModel = { phase: "application", order: 0, global: false };
  const argument = decorator.arguments.at(0);
  if (argument === undefined) {
    return defaults;
  }
  if (decorator.arguments.length !== 1 || argument.kind !== "object-literal") {
    report(
      diagnostics,
      "INVALID_MIDDLEWARE_DECLARATION",
      "Middleware accepts one object literal of options.",
      argument.span,
    );
    return undefined;
  }
  let options: MiddlewareOptionsModel | undefined = defaults;
  for (const property of argument.properties) {
    options = middlewareOptionOf(property, options, diagnostics);
    if (options === undefined) {
      return undefined;
    }
  }
  return options;
}

function errorHandlerOrderOf(
  decorator: DecoratorUse,
  diagnostics: CompilerDiagnostic[],
): number | undefined {
  const argument = decorator.arguments.at(0);
  if (argument === undefined) {
    return 0;
  }
  if (decorator.arguments.length !== 1 || argument.kind !== "object-literal") {
    report(
      diagnostics,
      "INVALID_MIDDLEWARE_DECLARATION",
      "ErrorHandler accepts one object literal of options.",
      argument.span,
    );
    return undefined;
  }
  let order = 0;
  for (const property of argument.properties) {
    if (
      property.kind !== "property" ||
      property.key !== "order" ||
      property.value.kind !== "number-literal" ||
      !Number.isInteger(property.value.value)
    ) {
      report(
        diagnostics,
        "INVALID_MIDDLEWARE_DECLARATION",
        'ErrorHandler options only include an integer "order".',
        property.span,
      );
      return undefined;
    }
    order = property.value.value;
  }
  return order;
}

// 路径词汇（ADR 0006 W1）：静态段 + :param 段。冲突键把参数段归一为 ":"——同 shape 的两条
// 路由无论参数叫什么都是同一条注册。
interface RoutePathInfo {
  readonly path: string;
  readonly shapeKey: string;
  // 路径参数名集合(#274 硬错 6):Param 槽的键名必须都出现在这里。
  readonly parameters: ReadonlySet<string>;
}

function normalizedPrefix(
  value: string,
  span: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  if (value === "" || value === "/") {
    return "";
  }
  if (!value.startsWith("/")) {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `Route path ${JSON.stringify(value)} must start with "/".`,
      span,
    );
    return undefined;
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parameterSegmentShape(
  segment: string,
  path: string,
  parameters: Set<string>,
  span: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  const name = segment.slice(1);
  if (!parameterSegmentPattern.test(name)) {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `Route parameter ${JSON.stringify(segment)} must be :name with a valid identifier.`,
      span,
    );
    return undefined;
  }
  if (parameters.has(name)) {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `Route path ${JSON.stringify(path)} declares parameter ${JSON.stringify(name)} twice.`,
      span,
    );
    return undefined;
  }
  parameters.add(name);
  return ":";
}

function routePathOf(
  basePath: string,
  subPath: string,
  span: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): RoutePathInfo | undefined {
  const joined = `${basePath}${subPath}`;
  const path = joined === "" ? "/" : joined;
  const segments = path === "/" ? [] : path.slice(1).split("/");
  const parameters = new Set<string>();
  const shapeSegments: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith(":")) {
      const shape = parameterSegmentShape(segment, path, parameters, span, diagnostics);
      if (shape === undefined) {
        return undefined;
      }
      shapeSegments.push(shape);
      continue;
    }
    if (!literalSegmentPattern.test(segment)) {
      report(
        diagnostics,
        "INVALID_ROUTE_DECLARATION",
        `Route path segment ${JSON.stringify(segment)} is not supported.`,
        span,
        {
          help: "Use letters, digits, '.', '_', '~', '-' in static segments, or :name parameters.",
        },
      );
      return undefined;
    }
    shapeSegments.push(segment);
  }
  return { path, shapeKey: shapeSegments.join("/"), parameters };
}

const schemaSlots = ["params", "query", "body", "response"] as const;

type SchemaSlot = (typeof schemaSlots)[number];

function isSchemaSlot(key: string): key is SchemaSlot {
  return (schemaSlots as readonly string[]).includes(key);
}

// schema 引用（ADR 0006 W5）：装饰器运行时是 no-op，schema 值不会活到运行时——routes.ts 必须
// 按 module × exportName 重新 import，因此引用必须静态解析到应用源集内的具名导出 const。
function schemaRefOf(
  source: ParsedSource,
  slot: string,
  value: DecoratorArgumentValue,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): WebExportRefModel | undefined {
  if (value.kind !== "identifier-reference" || value.entity.kind !== "identifier") {
    report(
      diagnostics,
      "INVALID_ROUTE_SCHEMA",
      `Route ${slot} schema must be a plain identifier referencing an exported const.`,
      value.span,
      { help: schemaHelp },
    );
    return undefined;
  }
  const resolved = linker.resolveValueDeclaration(source, value.entity.name);
  if (resolved === undefined || !resolved.declaration.topLevel) {
    report(
      diagnostics,
      "INVALID_ROUTE_SCHEMA",
      `Cannot statically resolve route ${slot} schema ${value.entity.name}.`,
      value.span,
      { help: schemaHelp },
    );
    return undefined;
  }
  if (resolved.exportName === undefined) {
    report(
      diagnostics,
      "INVALID_ROUTE_SCHEMA",
      `Route ${slot} schema ${value.entity.name} must be exported so the generated route table can import it.`,
      value.span,
      { help: schemaHelp },
    );
    return undefined;
  }
  return { source: resolved.source, exportName: resolved.exportName };
}

function routeSchemaSlotOf(
  source: ParsedSource,
  property: ObjectLiteralProperty,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): readonly [SchemaSlot, WebExportRefModel] | undefined {
  if (property.kind === "unsupported-property") {
    report(
      diagnostics,
      "INVALID_ROUTE_SCHEMA",
      `Route schemas cannot use ${property.propertyKind} properties.`,
      property.span,
      { help: schemaHelp },
    );
    return undefined;
  }
  if (!isSchemaSlot(property.key)) {
    report(
      diagnostics,
      "INVALID_ROUTE_SCHEMA",
      `Route schemas do not include "${property.key}".`,
      property.span,
      { help: schemaHelp },
    );
    return undefined;
  }
  const ref = schemaRefOf(source, property.key, property.value, linker, diagnostics);
  return ref === undefined ? undefined : [property.key, ref];
}

interface RouteSchemaGroup {
  // 属性里的 schema 标识符要在声明这组 schema 的模块里回查，不是在 controller 模块里。
  readonly source: ParsedSource;
  readonly properties: readonly ObjectLiteralProperty[];
}

// schema 组既可以内联，也可以是指向顶层 const 对象字面量的标识符。后者是 handler 侧类型
// 标注的落点：`show(context: RequestContext<typeof showSchemas>)` 只提一次名字，内联形态
// 则要把整组 schema 类型在标注里重打一遍——比原先的 `as unknown` 断言更糟。
// 解析规则照 defineRouteMarker 办：顶层 const、静态可解析，且必须真的是对象字面量初始化。
function routeSchemaGroupOf(
  source: ParsedSource,
  argument: DecoratorArgumentValue,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): RouteSchemaGroup | undefined {
  if (argument.kind === "object-literal") {
    return { source, properties: argument.properties };
  }
  const resolved =
    argument.kind === "identifier-reference" && argument.entity.kind === "identifier"
      ? linker.resolveValueDeclaration(source, argument.entity.name)
      : undefined;
  if (
    resolved?.declaration.topLevel === true &&
    resolved.declaration.declarationKind === "const" &&
    resolved.declaration.initializer?.kind === "object-literal"
  ) {
    return { source: resolved.source, properties: resolved.declaration.initializer.properties };
  }
  report(
    diagnostics,
    "INVALID_ROUTE_SCHEMA",
    "Route schemas must be one object literal, or an identifier referencing a top-level const object literal, with params/query/body/response keys.",
    argument.span,
    { help: schemaHelp },
  );
  return undefined;
}

function routeSchemasOf(
  source: ParsedSource,
  argument: DecoratorArgumentValue,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): RouteSchemasModel | undefined {
  const group = routeSchemaGroupOf(source, argument, linker, diagnostics);
  if (group === undefined) {
    return undefined;
  }
  let schemas: RouteSchemasModel = {};
  for (const property of group.properties) {
    const slot = routeSchemaSlotOf(group.source, property, linker, diagnostics);
    if (slot === undefined) {
      return undefined;
    }
    schemas = { ...schemas, [slot[0]]: slot[1] };
  }
  return schemas;
}

// 槽位路由(#274)参数列表放开,逐参数由槽位解析裁决;旧 schemas 路由维持「至多一个
// RequestContext 参数」。
function validRouteHandlerMethod(
  method: ClassMethodDeclaration,
  controllerName: string,
  allowSlotParameters: boolean,
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  const name = method.name.kind === "identifier" ? method.name.name : undefined;
  if (
    name === undefined ||
    method.static ||
    method.accessibility !== "public" ||
    method.generator ||
    method.optional ||
    !method.implementation ||
    (!allowSlotParameters && method.parameters.length > 1)
  ) {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `Route handler on ${controllerName} must be a public instance method implementation with an identifier name.`,
      method.span,
    );
    return undefined;
  }
  return name;
}

function useTargetOf(
  source: ParsedSource,
  argument: DecoratorArgumentValue,
  middlewareById: ReadonlyMap<string, MiddlewareInfo>,
  linker: ProjectLinker,
): MiddlewareInfo | undefined {
  if (argument.kind !== "identifier-reference") {
    return undefined;
  }
  const symbol = linker.resolveEntity(source, argument.entity);
  if (symbol?.kind !== "class" || symbol.declaration?.kind !== "class") {
    return undefined;
  }
  const targetName = symbol.declaration.name;
  if (symbol.source === undefined || targetName === undefined) {
    return undefined;
  }
  return middlewareById.get(providerId(symbol.source.fileId, targetName));
}

function useTargetsOf(
  source: ParsedSource,
  decorators: readonly DecoratorUse[],
  middlewareById: ReadonlyMap<string, MiddlewareInfo>,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): readonly MiddlewareInfo[] {
  const middleware: MiddlewareInfo[] = [];
  for (const decorator of decorators) {
    if (!decorator.called || decorator.arguments.length === 0) {
      report(
        diagnostics,
        "INVALID_MIDDLEWARE_DECLARATION",
        "Use requires at least one middleware class argument.",
        decorator.span,
      );
      continue;
    }
    for (const argument of decorator.arguments) {
      const info = useTargetOf(source, argument, middlewareById, linker);
      if (info === undefined) {
        report(
          diagnostics,
          "INVALID_MIDDLEWARE_DECLARATION",
          "Use only accepts application classes marked @Middleware().",
          argument.span,
        );
        continue;
      }
      middleware.push(info);
    }
  }
  return middleware;
}

// 链压平（ADR 0006 W4）：全局 + 路由组(@Use 于 controller) + 单路由(@Use 于 handler)，
// beanId 去重后按 (阶段, order, beanId) 排序写死。挂载点只是成员资格与来源标注，
// 执行顺序与挂载位置、书写顺序无关。
function flattenedChain(
  globalMiddleware: readonly MiddlewareInfo[],
  controllerUse: readonly MiddlewareInfo[],
  routeUse: readonly MiddlewareInfo[],
): readonly RouteMiddlewareModel[] {
  const byBeanId = new Map<string, RouteMiddlewareModel>();
  const mounts: readonly (readonly [MiddlewareMountModel, readonly MiddlewareInfo[]])[] = [
    ["global", globalMiddleware],
    ["controller", controllerUse],
    ["route", routeUse],
  ];
  for (const [mount, entries] of mounts) {
    for (const entry of entries) {
      if (!byBeanId.has(entry.beanId)) {
        byBeanId.set(entry.beanId, {
          ref: entry.ref,
          beanId: entry.beanId,
          phase: entry.phase,
          order: entry.order,
          mount,
        });
      }
    }
  }
  return [...byBeanId.values()].toSorted((left, right) => {
    const phase = webPhaseRank(left.phase) - webPhaseRank(right.phase);
    if (phase !== 0) {
      return phase;
    }
    const order = left.order - right.order;
    return order === 0 ? compareUtf16CodeUnits(left.beanId, right.beanId) : order;
  });
}

interface RouteCandidate {
  readonly route: RouteModel;
  readonly shapeKey: string;
  readonly span: SourceSpan;
  readonly fileId: string;
}

// 同路径同方法重复注册是硬错（ADR 0006 W1 / #152）：按 (fileId, offset) 决定性排序后，
// 后到者点名先到者（双侧定位，沿用 DUPLICATE_CONFIG_PREFIX 先例）。
function reportRouteConflicts(
  candidates: readonly RouteCandidate[],
  diagnostics: CompilerDiagnostic[],
): readonly RouteModel[] {
  const ordered = candidates.toSorted((left, right) => {
    const file = compareUtf16CodeUnits(left.fileId, right.fileId);
    return file === 0 ? left.span.start.offset - right.span.start.offset : file;
  });
  const firstByKey = new Map<string, RouteCandidate>();
  const unique: RouteModel[] = [];
  for (const candidate of ordered) {
    const key = `${candidate.route.method} ${candidate.shapeKey}`;
    const first = firstByKey.get(key);
    if (first === undefined) {
      firstByKey.set(key, candidate);
      unique.push(candidate.route);
      continue;
    }
    report(
      diagnostics,
      "DUPLICATE_ROUTE",
      `Route ${candidate.route.method} ${candidate.route.path} is already registered by ${first.route.controllerId}#${first.route.handler}.`,
      candidate.span,
      {
        related: [
          {
            message: `${first.route.controllerId}#${first.route.handler}`,
            sourceSpan: first.span,
          },
        ],
        help: "Each method + path shape pair may be registered once; parameter names do not disambiguate.",
      },
    );
  }
  return unique;
}

interface ClassRoleScan {
  readonly source: ParsedSource;
  readonly declaration: ClassDeclaration;
  readonly web: ReadonlyMap<string, readonly DecoratorUse[]>;
}

function scanWebClasses(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
): readonly ClassRoleScan[] {
  const scans: ClassRoleScan[] = [];
  for (const source of sources) {
    if (source.sourceKind.startsWith("d.")) {
      continue;
    }
    for (const declaration of source.unit.classes) {
      const classLevel = webDecoratorsOf(source, declaration.decorators, linker);
      const anyMethodLevel = declaration.methods.some(
        (method) => webDecoratorsOf(source, method.decorators, linker).size > 0,
      );
      if (classLevel.size > 0 || anyMethodLevel) {
        scans.push({ source, declaration, web: classLevel });
      }
    }
  }
  return scans;
}

interface WebBeanRegistry {
  readonly middlewareById: ReadonlyMap<string, MiddlewareInfo>;
  readonly errorHandlers: readonly WebErrorHandlerModel[];
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

function registerMiddleware(
  scan: ClassRoleScan,
  providerById: ReadonlyMap<string, ProviderModel>,
  middlewareById: Map<string, MiddlewareInfo>,
  diagnostics: CompilerDiagnostic[],
): void {
  const decorator = singleCalledDecorator(
    "Middleware",
    scan.web.get("Middleware") ?? [],
    "INVALID_MIDDLEWARE_DECLARATION",
    diagnostics,
  );
  if (decorator === undefined) {
    return;
  }
  const claim = claimWebBean(
    scan.source,
    scan.declaration,
    "middleware",
    providerById,
    diagnostics,
  );
  const options = middlewareOptionsOf(decorator, diagnostics);
  if (claim !== undefined && options !== undefined) {
    middlewareById.set(claim.beanId, {
      ref: claim.ref,
      beanId: claim.beanId,
      phase: options.phase,
      order: options.order,
      global: options.global,
    });
  }
}

function registerErrorHandler(
  scan: ClassRoleScan,
  providerById: ReadonlyMap<string, ProviderModel>,
  errorHandlers: WebErrorHandlerModel[],
  diagnostics: CompilerDiagnostic[],
): void {
  const decorator = singleCalledDecorator(
    "ErrorHandler",
    scan.web.get("ErrorHandler") ?? [],
    "INVALID_MIDDLEWARE_DECLARATION",
    diagnostics,
  );
  if (decorator === undefined) {
    return;
  }
  const claim = claimWebBean(
    scan.source,
    scan.declaration,
    "error-handler",
    providerById,
    diagnostics,
  );
  const order = errorHandlerOrderOf(decorator, diagnostics);
  if (claim !== undefined && order !== undefined) {
    errorHandlers.push({ ref: claim.ref, beanId: claim.beanId, order });
  }
}

// 第一遍：中间件与错误处理器登记（@Use 与全局链要先有名录），并拒绝一类多角色。
function registerWebBeans(
  scans: readonly ClassRoleScan[],
  providerById: ReadonlyMap<string, ProviderModel>,
  diagnostics: CompilerDiagnostic[],
): WebBeanRegistry {
  const middlewareById = new Map<string, MiddlewareInfo>();
  const errorHandlers: WebErrorHandlerModel[] = [];
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
    registerMiddleware(scan, providerById, middlewareById, diagnostics);
    registerErrorHandler(scan, providerById, errorHandlers, diagnostics);
  }
  return { middlewareById, errorHandlers };
}

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

// tsgo 返回正斜杠规范路径,Windows 上大小写也要折叠(同 type-query 的 canonicalPathKey 口径)。
function canonicalPathOf(filePath: string): string {
  const portable = filePath.replaceAll("\\", "/");
  return process.platform === "win32" ? portable.toLowerCase() : portable;
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
    sources.map((source) => [canonicalPathOf(source.absolutePath), source.fileId as string]),
  );
  const fileIdOf = (declarationPath: string): string | undefined =>
    fileIdBySourcePath.get(canonicalPathOf(declarationPath));
  const registry = registerWebBeans(scans, providerById, diagnostics);
  const globalMiddleware = [...registry.middlewareById.values()]
    .filter((middleware) => middleware.global)
    .toSorted((left, right) => compareUtf16CodeUnits(left.beanId, right.beanId));

  const candidates: RouteCandidate[] = [];
  for (const scan of scans) {
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
    collectControllerRoutes({
      scan,
      controllerDecorator: isController ? controllerDecorator : undefined,
      allowRoutes: isController && !isOtherRole,
      linker,
      typeQuery,
      fileIdOf,
      providerById,
      middlewareById: registry.middlewareById,
      globalMiddleware,
      markers,
      candidates,
      diagnostics,
    });
  }

  const routes = reportRouteConflicts(candidates, diagnostics).toSorted((left, right) => {
    const path = compareUtf16CodeUnits(left.path, right.path);
    return path === 0 ? compareUtf16CodeUnits(left.method, right.method) : path;
  });
  const orderedErrorHandlers = registry.errorHandlers.toSorted((left, right) => {
    const order = left.order - right.order;
    return order === 0 ? compareUtf16CodeUnits(left.beanId, right.beanId) : order;
  });
  return {
    routes: Object.freeze(routes),
    errorHandlers: Object.freeze(orderedErrorHandlers),
    engines: Object.freeze(wiring.engines),
    ...(wiring.requestSeeder === undefined ? {} : { requestSeeder: wiring.requestSeeder }),
  };
}

interface ControllerRouteInputs {
  readonly scan: ClassRoleScan;
  readonly controllerDecorator: DecoratorUse | undefined;
  readonly allowRoutes: boolean;
  readonly linker: ProjectLinker;
  readonly typeQuery: TypeQuery | undefined;
  readonly fileIdOf: (declarationPath: string) => string | undefined;
  readonly providerById: ReadonlyMap<string, ProviderModel>;
  readonly middlewareById: ReadonlyMap<string, MiddlewareInfo>;
  readonly globalMiddleware: readonly MiddlewareInfo[];
  readonly markers: ReadonlyMap<string, RouteMarkerDeclarationInfo>;
  readonly candidates: RouteCandidate[];
  readonly diagnostics: CompilerDiagnostic[];
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

function reportMisplacedMethodDecorators(
  methodWeb: ReadonlyMap<string, readonly DecoratorUse[]>,
  method: ClassMethodDeclaration,
  diagnostics: CompilerDiagnostic[],
): void {
  for (const [name, decorators] of methodWeb.entries()) {
    if (routeDecoratorNames.has(name) || name === "Use") {
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

function collectControllerRoutes(inputs: ControllerRouteInputs): void {
  const { scan, diagnostics } = inputs;
  const controllerName = scan.declaration.name ?? "an anonymous class";
  const claim = inputs.allowRoutes
    ? claimWebBean(scan.source, scan.declaration, "controller", inputs.providerById, diagnostics)
    : undefined;
  const basePath = inputs.allowRoutes
    ? controllerBasePath(inputs.controllerDecorator, diagnostics)
    : undefined;
  const controllerUse = useTargetsOf(
    scan.source,
    scan.web.get("Use") ?? [],
    inputs.middlewareById,
    inputs.linker,
    diagnostics,
  );
  if (!inputs.allowRoutes && (scan.web.get("Use")?.length ?? 0) > 0) {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `Use on ${controllerName} needs a @Controller class: only controllers mount route middleware.`,
      scan.declaration.span,
    );
  }
  for (const method of scan.declaration.methods) {
    collectMethodRoutes(inputs, method, controllerName, claim, basePath, controllerUse);
  }
}

function collectMethodRoutes(
  inputs: ControllerRouteInputs,
  method: ClassMethodDeclaration,
  controllerName: string,
  claim: WebBeanClaim | undefined,
  basePath: string | undefined,
  controllerUse: readonly MiddlewareInfo[],
): void {
  const { scan, diagnostics } = inputs;
  const methodWeb = webDecoratorsOf(scan.source, method.decorators, inputs.linker);
  const routeDecorators = [...methodWeb.entries()].filter(([name]) =>
    routeDecoratorNames.has(name),
  );
  reportMisplacedMethodDecorators(methodWeb, method, diagnostics);
  if (routeDecorators.length === 0) {
    if (methodWeb.has("Use")) {
      report(
        diagnostics,
        "INVALID_ROUTE_DECLARATION",
        "Use on a method requires a route decorator on the same method.",
        methodWeb.get("Use")?.at(0)?.span ?? method.span,
      );
    }
    return;
  }
  if (!inputs.allowRoutes) {
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
  // 路径触发判定(#274 过渡态):任一路由装饰器带 schemas 实参 → 整方法走旧分析路径;
  // 未传 schemas → 槽位解析(零参 = 空槽位;唯一 RequestContext 参数 = requestContext 槽,
  // 与旧 handlerArity 语义等价)。旧链路删除后 schemas 实参本身转为迁移硬错。
  const usesSchemas = routeDecorators.some(([, decorators]) =>
    decorators.some((decorator) => decorator.arguments.length > 1),
  );
  const handlerName = validRouteHandlerMethod(method, controllerName, !usesSchemas, diagnostics);
  if (handlerName === undefined) {
    return;
  }
  let contract: RouteContractModel | undefined;
  if (!usesSchemas) {
    contract = resolveRouteSlots({
      method,
      controllerName,
      context: createSlotResolutionContext({
        source: scan.source,
        method,
        linker: inputs.linker,
        query: inputs.typeQuery,
        fileIdOf: inputs.fileIdOf,
        diagnostics,
      }),
    });
    if (contract === undefined) {
      return;
    }
  }
  const routeUse = useTargetsOf(
    scan.source,
    methodWeb.get("Use") ?? [],
    inputs.middlewareById,
    inputs.linker,
    diagnostics,
  );
  pushRouteCandidates(inputs, {
    routeDecorators,
    basePath,
    claim,
    handlerName,
    handlerArity: method.parameters.length === 0 ? 0 : 1,
    contract,
    middleware: flattenedChain(inputs.globalMiddleware, controllerUse, routeUse),
    meta: routeMetaOf(scan.source, method, inputs.markers, inputs.linker, diagnostics),
  });
}

interface RouteCandidateInputs {
  readonly routeDecorators: readonly (readonly [string, readonly DecoratorUse[]])[];
  readonly basePath: string;
  readonly claim: WebBeanClaim;
  readonly handlerName: string;
  readonly handlerArity: 0 | 1;
  readonly contract: RouteContractModel | undefined;
  readonly middleware: readonly RouteMiddlewareModel[];
  readonly meta: ReadonlyMap<string, RouteMetaValueModel>;
}

function pushRouteCandidates(
  inputs: ControllerRouteInputs,
  candidateInputs: RouteCandidateInputs,
): void {
  for (const [decoratorName, decorators] of candidateInputs.routeDecorators) {
    for (const decorator of decorators) {
      const route = routeOf({
        source: inputs.scan.source,
        decoratorName,
        decorator,
        basePath: candidateInputs.basePath,
        claim: candidateInputs.claim,
        handlerName: candidateInputs.handlerName,
        handlerArity: candidateInputs.handlerArity,
        contract: candidateInputs.contract,
        middleware: candidateInputs.middleware,
        meta: candidateInputs.meta,
        linker: inputs.linker,
        diagnostics: inputs.diagnostics,
      });
      if (route !== undefined) {
        inputs.candidates.push(route);
      }
    }
  }
}

interface RouteOfInputs {
  readonly source: ParsedSource;
  readonly decoratorName: string;
  readonly decorator: DecoratorUse;
  readonly basePath: string;
  readonly claim: WebBeanClaim;
  readonly handlerName: string;
  readonly handlerArity: 0 | 1;
  readonly contract: RouteContractModel | undefined;
  readonly middleware: readonly RouteMiddlewareModel[];
  readonly meta: ReadonlyMap<string, RouteMetaValueModel>;
  readonly linker: ProjectLinker;
  readonly diagnostics: CompilerDiagnostic[];
}

function routeSubPathOf(inputs: RouteOfInputs): string | undefined {
  const pathArgument = inputs.decorator.arguments.at(0);
  if (pathArgument === undefined) {
    return "";
  }
  if (pathArgument.kind !== "string-literal") {
    report(
      inputs.diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `${inputs.decoratorName} path must be a string literal.`,
      pathArgument.span,
    );
    return undefined;
  }
  return normalizedPrefix(pathArgument.value, pathArgument.span, inputs.diagnostics);
}

function routeOf(inputs: RouteOfInputs): RouteCandidate | undefined {
  const { decorator, diagnostics } = inputs;
  if (!decorator.called || decorator.arguments.length > 2) {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `${inputs.decoratorName} must be called with an optional path literal and an optional schemas object.`,
      decorator.span,
    );
    return undefined;
  }
  const subPath = routeSubPathOf(inputs);
  if (subPath === undefined) {
    return undefined;
  }
  const pathInfo = routePathOf(inputs.basePath, subPath, decorator.span, diagnostics);
  if (pathInfo === undefined) {
    return undefined;
  }
  // 硬错 6(#274)按路由复裁:同方法多路由装饰器时各自的路径参数集不同,槽位解析本身
  // per-method 只跑一次。
  if (
    inputs.contract !== undefined &&
    !reportUnknownPathParameters(inputs.contract, pathInfo.path, pathInfo.parameters, diagnostics)
  ) {
    return undefined;
  }
  const schemaArgument = decorator.arguments.at(1);
  const schemas =
    schemaArgument === undefined
      ? {}
      : routeSchemasOf(inputs.source, schemaArgument, inputs.linker, diagnostics);
  if (schemas === undefined) {
    return undefined;
  }
  // 名字表驱动：routeDecoratorNames 已经证明成员资格，索引推不回值联合
  // // justified: 见上一行
  const method =
    routeMethodByDecorator[inputs.decoratorName as keyof typeof routeMethodByDecorator];
  return {
    route: {
      method,
      path: pathInfo.path,
      controller: inputs.claim.ref,
      controllerId: inputs.claim.beanId,
      handler: inputs.handlerName,
      handlerArity: inputs.handlerArity,
      middleware: inputs.middleware,
      meta: inputs.meta,
      schemas,
      ...(inputs.contract === undefined ? {} : { contract: inputs.contract }),
      source: sourceReference(decorator.span),
    },
    shapeKey: pathInfo.shapeKey,
    span: decorator.span,
    fileId: inputs.source.fileId,
  };
}

// marker 使用：callee 不是 web 符号的方法装饰器里，凡能解析到 defineRouteMarker 声明的都算
// marker（同文件本地 const 或一跳具名 import）。其余解析不到的装饰器不属于 Reforce，保持沉默。
function markerUseOf(
  source: ParsedSource,
  decorator: DecoratorUse,
  markers: ReadonlyMap<string, RouteMarkerDeclarationInfo>,
  linker: ProjectLinker,
): RouteMarkerDeclarationInfo | undefined {
  if (decorator.callee.kind !== "identifier") {
    return undefined;
  }
  if (linker.resolveEntity(source, decorator.callee) !== undefined) {
    return undefined;
  }
  const resolved = linker.resolveValueDeclaration(source, decorator.callee.name);
  if (resolved?.declaration.name === undefined) {
    return undefined;
  }
  return markers.get(markerRegistryKey(resolved.source.fileId, resolved.declaration.name));
}

function markerValueOf(
  decorator: DecoratorUse,
  diagnostics: CompilerDiagnostic[],
): RouteMetaValueModel | undefined {
  if (!decorator.called || decorator.arguments.length !== 1) {
    report(
      diagnostics,
      "INVALID_ROUTE_MARKER_VALUE",
      "A route marker must be applied with exactly one value.",
      decorator.span,
      { help: markerValueHelp },
    );
    return undefined;
  }
  const argument = decorator.arguments[0];
  return argument === undefined ? undefined : metaValueOf(argument, diagnostics);
}

// 同一路由重复同 key 是硬错（meta 是按 key 的单值表）。
function routeMetaOf(
  source: ParsedSource,
  method: ClassMethodDeclaration,
  markers: ReadonlyMap<string, RouteMarkerDeclarationInfo>,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): ReadonlyMap<string, RouteMetaValueModel> {
  const meta = new Map<string, RouteMetaValueModel>();
  const firstSpanByKey = new Map<string, SourceSpan>();
  for (const decorator of method.decorators) {
    const marker = markerUseOf(source, decorator, markers, linker);
    if (marker === undefined) {
      continue;
    }
    const value = markerValueOf(decorator, diagnostics);
    if (value === undefined) {
      continue;
    }
    const firstSpan = firstSpanByKey.get(marker.key);
    if (firstSpan !== undefined) {
      report(
        diagnostics,
        "INVALID_ROUTE_MARKER_VALUE",
        `Route marker key ${JSON.stringify(marker.key)} appears twice on the same route.`,
        decorator.span,
        { related: [{ message: marker.key, sourceSpan: firstSpan }] },
      );
      continue;
    }
    firstSpanByKey.set(marker.key, decorator.span);
    meta.set(marker.key, value);
  }
  return meta;
}
