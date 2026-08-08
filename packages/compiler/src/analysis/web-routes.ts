import { compareUtf16CodeUnits } from "@reforce/primitives";
import { type BeanRole, beanRoleSpecOf, claimRoleBean } from "@/analysis/bean-roles";
import { type ProviderModel, providerId, sourceReference } from "@/analysis/model";
import {
  type ErrorAcceptsModel,
  emptyWebModel,
  type HttpMethodModel,
  type MiddlewareMountModel,
  type ResponseContractModel,
  type RouteContractModel,
  type RouteMetaValueModel,
  type RouteMiddlewareModel,
  type RouteModel,
  type RouteThrownErrorModel,
  type WebEngineModel,
  type WebErrorHandlerModel,
  type WebExportRefModel,
  type WebModel,
  type WebPhaseModel,
  webPhaseOrder,
  webPhaseRank,
} from "@/analysis/web-model";
import { createSlotResolutionContext } from "@/analysis/web-slot-context";
import {
  type ResponseDirectives,
  type ResponseSchemaDirectiveModel,
  type ResponseStatusModel,
  reportUnknownPathParameters,
  resolveResponseDeclaration,
  resolveRouteSlots,
} from "@/analysis/web-slots";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { ProjectLinker } from "@/linking/project-linker";
import type { StarterBeanModel } from "@/linking/starter-linking";
import type {
  ClassDeclaration,
  ClassMethodDeclaration,
  DecoratorArgumentValue,
  DecoratorUse,
  EntityName,
  ObjectLiteralProperty,
  TypeNode,
  ValueDeclaration,
} from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";
import type { TypeQuery } from "@/typescript/type-query";

// web 路由分析（ADR 0006 W1/W3/W4/W5，#142 / #152）：controller/中间件/错误处理器都是 bean，
// 身份由各自的角色装饰器蕴含（bean-roles.ts）。这里静态提取路由表：路径归并与冲突检测、
// marker 字面量提取、槽位契约解析(RFC 0012 S2,#274)、中间件链按 (阶段, order, beanId)
// 压平写死。

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
  // 类级 @Throws 原始形态(#275):处理器名录建成后统一解析,挂载路由取并集。
  readonly throwsDecorators: readonly DecoratorUse[];
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

// ———— S3 响应侧装饰器的语法层解析(#275) ————

interface ParsedResponseStatus {
  readonly status?: ResponseStatusModel;
  readonly failed: boolean;
}

// 不复用 metaValueOf:它的错误码/词表是路由 marker 的,且接受任意 JSON 树,这里恰要一个
// 100–599 的整数字面量。
function responseStatusOf(
  decorators: readonly DecoratorUse[],
  diagnostics: CompilerDiagnostic[],
): ParsedResponseStatus {
  const decorator = singleCalledDecorator(
    "ResponseStatus",
    decorators,
    "INVALID_RESPONSE_STATUS",
    diagnostics,
  );
  if (decorator === undefined) {
    return { failed: decorators.length > 0 };
  }
  const argument = decorator.arguments.at(0);
  if (
    decorator.arguments.length !== 1 ||
    argument?.kind !== "number-literal" ||
    !Number.isInteger(argument.value) ||
    argument.value < 100 ||
    argument.value > 599
  ) {
    report(
      diagnostics,
      "INVALID_RESPONSE_STATUS",
      "ResponseStatus takes exactly one integer literal between 100 and 599.",
      argument?.span ?? decorator.span,
    );
    return { failed: true };
  }
  return { status: { value: argument.value, span: argument.span }, failed: false };
}

interface ParsedResponseSchema {
  readonly schema?: ResponseSchemaDirectiveModel;
  readonly failed: boolean;
}

function responseSchemaOf(
  decorators: readonly DecoratorUse[],
  diagnostics: CompilerDiagnostic[],
): ParsedResponseSchema {
  const decorator = singleCalledDecorator(
    "ResponseSchema",
    decorators,
    "INVALID_RESPONSE_SCHEMA",
    diagnostics,
  );
  if (decorator === undefined) {
    return { failed: decorators.length > 0 };
  }
  const argument = decorator.arguments.at(0);
  if (decorator.arguments.length !== 1 || argument?.kind !== "identifier-reference") {
    report(
      diagnostics,
      "INVALID_RESPONSE_SCHEMA",
      "ResponseSchema takes exactly one reference to a Standard Schema value.",
      argument?.span ?? decorator.span,
    );
    return { failed: true };
  }
  return { schema: { entity: argument.entity, span: argument.span }, failed: false };
}

// ———— @Throws 解析与处理器匹配(#275) ————

const errorHandlerSignatureHelp =
  "Typed error handlers declare handle as a method whose first parameter is annotated with an " +
  "exported, non-generic application error class; `unknown` (or a field-form handle) keeps the " +
  "handler match-all. @Throws additionally accepts a const created by defineHttpError(...) — " +
  "those errors carry their own status and code and need no handler.";

interface ErrorHandlerInfo extends WebErrorHandlerModel {
  // 声明位:THROWS_WITHOUT_HANDLER 的 related span 点名已注册处理器。
  readonly span: SourceSpan;
}

interface ThrowsResolutionContext {
  readonly linker: ProjectLinker;
  // 分派序(order, beanId)下每个 accepts 类键的首个处理器:manifest 绑定的就是运行时赢家。
  readonly handlersByAcceptKey: ReadonlyMap<string, ErrorHandlerInfo>;
  readonly orderedHandlers: readonly ErrorHandlerInfo[];
  readonly diagnostics: CompilerDiagnostic[];
}

// 语法继承链限深:与 web-slots 的 aliasFollowLimit 同一预算——循环 extends 无稳定去重身份。
const heritageFollowLimit = 16;

function heritageClassOf(
  target: ApplicationClassTarget,
  linker: ProjectLinker,
): ApplicationClassTarget | undefined {
  const heritage = target.declaration.heritage;
  // call(extends f(...))与 expression 形态无法静态跟出类身份,继承链在此断开。
  if (heritage?.kind !== "reference") {
    return undefined;
  }
  return applicationClassTargetOf(target.source, heritage.entity, linker);
}

// 镜像运行时 instanceof:@Throws(Sub) 可被收 Base 的处理器满足,沿 source-ir 语法继承链向上。
function handlerForThrownClass(
  target: ApplicationClassTarget,
  context: ThrowsResolutionContext,
): ErrorHandlerInfo | undefined {
  let current: ApplicationClassTarget | undefined = target;
  for (let depth = 0; depth <= heritageFollowLimit && current !== undefined; depth += 1) {
    const handler = context.handlersByAcceptKey.get(current.key);
    if (handler !== undefined) {
      return handler;
    }
    current = heritageClassOf(current, context.linker);
  }
  return undefined;
}

function resolveThrowsDecorators(
  source: ParsedSource,
  decorators: readonly DecoratorUse[],
  context: ThrowsResolutionContext,
): { readonly throws: readonly RouteThrownErrorModel[]; readonly failed: boolean } {
  const throws: RouteThrownErrorModel[] = [];
  let failed = false;
  for (const decorator of decorators) {
    if (!decorator.called || decorator.arguments.length === 0) {
      failed = true;
      report(
        context.diagnostics,
        "INVALID_ERROR_HANDLER_SIGNATURE",
        "Throws requires at least one application error class argument.",
        decorator.span,
        { help: errorHandlerSignatureHelp },
      );
      continue;
    }
    for (const argument of decorator.arguments) {
      const resolved = resolveThrownArgument(source, argument, context);
      if (resolved === undefined) {
        failed = true;
        continue;
      }
      throws.push(resolved);
    }
  }
  return { throws, failed };
}

// defineHttpError 造的异常(#310):const 初始化是 @reforce/web defineHttpError 的直接调用。
// 这类异常没有类声明,类型化处理器的 accepts 写不出来,而运行时兜底闭集(ADR 0013 决议 6/7)
// 直接把 HttpError 翻译成 problem+json——所以 @Throws 直接绑内置契约,不查处理器名录。
// status/code 取实参的静态字面量,写成变量等非字面量时缺省(文档只收静态可知的事实,#306
// 同口径)。
// 状态码合法域与 @ResponseStatus 同口径:非整数或出 100-599 的字面量不落 status——openapi
// 的 responses 键必须是合法状态码,写进去只会砸下游校验器。
function literalStatusOf(argument: DecoratorArgumentValue | undefined): number | undefined {
  if (argument?.kind !== "number-literal") {
    return undefined;
  }
  const value = argument.value;
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function definedHttpErrorTargetOf(
  source: ParsedSource,
  entity: EntityName,
  linker: ProjectLinker,
): RouteThrownErrorModel | undefined {
  // 只认裸标识符:限定名(NS.X / X.foo)按最左标识符解析会把 X.foo 误认成 X,宁可不认。
  if (entity.kind !== "identifier") {
    return undefined;
  }
  const resolved = linker.resolveValueDeclaration(source, entity.name);
  const name = resolved?.declaration.name;
  if (resolved === undefined || name === undefined) {
    return undefined;
  }
  if (resolved.declaration.declarationKind !== "const") {
    return undefined;
  }
  const initializer = resolved.declaration.initializer;
  if (initializer?.kind !== "call") {
    return undefined;
  }
  const callee = linker.resolveEntity(resolved.source, initializer.callee);
  if (callee?.kind !== "web" || callee.name !== "defineHttpError") {
    return undefined;
  }
  const code = initializer.arguments.at(0);
  const status = literalStatusOf(initializer.arguments.at(2));
  return {
    kind: "http-error",
    errorName: name,
    key: providerId(resolved.source.fileId, name),
    ...(status === undefined ? {} : { status }),
    ...(code?.kind === "string-literal" ? { code: code.value } : {}),
  };
}

function resolveThrownArgument(
  source: ParsedSource,
  argument: DecoratorArgumentValue,
  context: ThrowsResolutionContext,
): RouteThrownErrorModel | undefined {
  const invalid = (): undefined =>
    report(
      context.diagnostics,
      "INVALID_ERROR_HANDLER_SIGNATURE",
      "Throws only accepts application error classes or defineHttpError values.",
      argument.span,
      { help: errorHandlerSignatureHelp },
    );
  if (argument.kind !== "identifier-reference") {
    return invalid();
  }
  const target = applicationClassTargetOf(source, argument.entity, context.linker);
  if (target === undefined) {
    return definedHttpErrorTargetOf(source, argument.entity, context.linker) ?? invalid();
  }
  const handler = handlerForThrownClass(target, context);
  if (handler === undefined) {
    report(
      context.diagnostics,
      "THROWS_WITHOUT_HANDLER",
      `No registered error handler accepts ${target.name} (or one of its base classes).`,
      argument.span,
      {
        help:
          "Declare an @ErrorHandler() class whose handle method accepts this error class; " +
          "match-all handlers do not satisfy @Throws because the wire contract needs a status and body shape.",
        related: context.orderedHandlers.map((entry) => ({
          message: entry.beanId,
          sourceSpan: entry.span,
        })),
      },
    );
    return undefined;
  }
  return {
    kind: "handler",
    errorName: target.name,
    key: target.key,
    handlerBeanId: handler.beanId,
  };
}

// 路由 throws = 方法级 @Throws ∪ 挂载中间件类级 @Throws:按类键去重、errorName 排序(同名
// 异文件再按 key 决胜),manifest 与 explain 的顺序由此确定。
function unionThrows(
  lists: readonly (readonly RouteThrownErrorModel[])[],
): readonly RouteThrownErrorModel[] {
  const byKey = new Map<string, RouteThrownErrorModel>();
  for (const item of lists.flat()) {
    if (!byKey.has(item.key)) {
      byKey.set(item.key, item);
    }
  }
  return [...byKey.values()].toSorted((left, right) => {
    const name = compareUtf16CodeUnits(left.errorName, right.errorName);
    return name === 0 ? compareUtf16CodeUnits(left.key, right.key) : name;
  });
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

// 参数列表形态不设上限(#274):逐参数合法性全部由槽位解析裁决。
function validRouteHandlerMethod(
  method: ClassMethodDeclaration,
  controllerName: string,
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  const name = method.name.kind === "identifier" ? method.name.name : undefined;
  if (
    name === undefined ||
    method.static ||
    method.accessibility !== "public" ||
    method.generator ||
    method.optional ||
    !method.implementation
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

// 应用类引用的统一解析(#275 抽自 useTargetOf):@Use 的中间件类、错误处理器 accepts 的
// 错误类与 @Throws 实参共用。key 与 providerId 同构,是类身份的比对键;exportName 缺失
// 意味着 routes.ts 无法 import 该类(accepts 场景硬错,@Use 场景在名录查找时自然落空)。
interface ApplicationClassTarget {
  readonly source: ParsedSource;
  readonly declaration: ClassDeclaration;
  readonly name: string;
  readonly key: string;
  readonly exportName?: string;
}

function applicationClassTargetOf(
  source: ParsedSource,
  entity: EntityName,
  linker: ProjectLinker,
): ApplicationClassTarget | undefined {
  const symbol = linker.resolveEntity(source, entity);
  if (symbol?.kind !== "class" || symbol.declaration?.kind !== "class") {
    return undefined;
  }
  const declaration = symbol.declaration;
  const targetName = declaration.name;
  if (symbol.source === undefined || targetName === undefined) {
    return undefined;
  }
  return {
    source: symbol.source,
    declaration,
    name: targetName,
    key: providerId(symbol.source.fileId, targetName),
    ...(declaration.export.kind === "named" ? { exportName: declaration.export.exportedName } : {}),
  };
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
  const target = applicationClassTargetOf(source, argument.entity, linker);
  return target === undefined ? undefined : middlewareById.get(target.key);
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
      throwsDecorators: scan.web.get("Throws") ?? [],
    });
  }
}

// 错误处理器的类型分析接线(#275):handle 方法的 accepts 与响应声明都要查 checker。
interface ErrorHandlerAnalysisInputs {
  readonly linker: ProjectLinker;
  readonly typeQuery: TypeQuery | undefined;
  readonly fileIdOf: (declarationPath: string) => string | undefined;
}

// handle 参数 0 的 accepts 裁决(语法层):项目类 ⇒ instanceof 闸;unknown/缺失 ⇒ match-all
// (S2 处理器全部原样落这里);其余(接口/联合/框架类/泛型/未导出类)⇒ 硬错——运行时闸靠
// instanceof、生成物靠 import,两者都只有导出的项目类给得起。
function errorHandlerAcceptsOf(
  scan: ClassRoleScan,
  handlerName: string,
  annotation: TypeNode | undefined,
  linker: ProjectLinker,
  diagnostics: CompilerDiagnostic[],
): { readonly accepts?: ErrorAcceptsModel; readonly failed: boolean } {
  if (
    annotation === undefined ||
    (annotation.kind === "primitive" && annotation.name === "unknown")
  ) {
    return { failed: false };
  }
  const invalid = (detail: string): { readonly failed: boolean } => {
    report(
      diagnostics,
      "INVALID_ERROR_HANDLER_SIGNATURE",
      `The handle method of ${handlerName} ${detail}`,
      annotation.span,
      { help: errorHandlerSignatureHelp },
    );
    return { failed: true };
  };
  if (annotation.kind !== "reference" || annotation.typeArguments.length > 0) {
    return invalid("accepts a type that is not a plain class reference.");
  }
  const target = applicationClassTargetOf(scan.source, annotation.name, linker);
  if (target === undefined) {
    return invalid(
      "accepts a type that does not resolve to an application class; interfaces, unions and framework types cannot drive the instanceof gate.",
    );
  }
  if (target.declaration.generic) {
    return invalid(
      `accepts the generic class ${target.name}; type arguments do not survive instanceof.`,
    );
  }
  if (target.exportName === undefined) {
    return invalid(
      `accepts ${target.name}, which is not exported; the generated route table must import it for the instanceof gate.`,
    );
  }
  return {
    accepts: {
      ref: { source: target.source, exportName: target.exportName },
      key: target.key,
      name: target.name,
    },
    failed: false,
  };
}

// 错误处理器的形状分析(#275):accepts + 响应声明。field-form handle 不在 declaration.methods,
// 保持 match-all + passthrough(运行时按「返回 Response 即接管」消费,文档与诊断 help 写明)。
function errorHandlerShapeOf(
  scan: ClassRoleScan,
  status: ResponseStatusModel | undefined,
  analysis: ErrorHandlerAnalysisInputs,
  diagnostics: CompilerDiagnostic[],
): { readonly accepts?: ErrorAcceptsModel; readonly response: ResponseContractModel } | undefined {
  const handlerName = scan.declaration.name ?? "an anonymous class";
  const handle = scan.declaration.methods.find(
    (method) =>
      method.name.kind === "identifier" && method.name.name === "handle" && method.implementation,
  );
  if (handle === undefined) {
    if (status !== undefined) {
      report(
        diagnostics,
        "INVALID_RESPONSE_STATUS",
        `${handlerName} declares @ResponseStatus but its handle is not a method; a field-form handle stays match-all and must return Response itself.`,
        status.span,
        { help: errorHandlerSignatureHelp },
      );
      return undefined;
    }
    return { response: { kind: "passthrough" } };
  }
  const acceptsResult = errorHandlerAcceptsOf(
    scan,
    handlerName,
    handle.parameters.at(0)?.typeAnnotation,
    analysis.linker,
    diagnostics,
  );
  if (acceptsResult.failed) {
    return undefined;
  }
  const response = resolveResponseDeclaration({
    context: createSlotResolutionContext({
      source: scan.source,
      method: handle,
      linker: analysis.linker,
      query: analysis.typeQuery,
      fileIdOf: analysis.fileIdOf,
      diagnostics,
    }),
    subject: `${handlerName}#handle`,
    annotation: handle.returnType,
    anchorSpan: handle.returnType?.span ?? handle.span,
    directives: status === undefined ? {} : { status },
    role: "error-handler",
  });
  if (response === undefined) {
    return undefined;
  }
  return {
    ...(acceptsResult.accepts === undefined ? {} : { accepts: acceptsResult.accepts }),
    response,
  };
}

function registerErrorHandler(
  scan: ClassRoleScan,
  providerById: ReadonlyMap<string, ProviderModel>,
  errorHandlers: ErrorHandlerInfo[],
  analysis: ErrorHandlerAnalysisInputs,
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
  const parsedStatus = responseStatusOf(scan.web.get("ResponseStatus") ?? [], diagnostics);
  if (claim === undefined || order === undefined || parsedStatus.failed) {
    return;
  }
  const shape = errorHandlerShapeOf(scan, parsedStatus.status, analysis, diagnostics);
  if (shape === undefined) {
    return;
  }
  errorHandlers.push({
    ref: claim.ref,
    beanId: claim.beanId,
    order,
    span: scan.declaration.span,
    ...shape,
  });
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
function registerWebBeans(
  scans: readonly ClassRoleScan[],
  providerById: ReadonlyMap<string, ProviderModel>,
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
    registerMiddleware(scan, providerById, middlewareById, diagnostics);
    registerErrorHandler(scan, providerById, errorHandlers, analysis, diagnostics);
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

// @Throws 匹配的准备(#275):accepts 键表按分派序取首个(运行时赢家),中间件类级 @Throws
// 在处理器名录落定后统一解析。
function prepareThrowsResolution(
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
      throwsContext,
      middlewareThrows,
      candidates,
      diagnostics,
    });
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
  readonly throwsContext: ThrowsResolutionContext;
  readonly middlewareThrows: ReadonlyMap<string, readonly RouteThrownErrorModel[]>;
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

// S3 响应侧装饰器(#275):三者的语法解析先于槽位解析,任何一处失败都弃整个方法——
// 半套指令继续解析只会产出互相矛盾的诊断(与旧 schemas 实参同一口径)。
function routeResponseDirectivesOf(
  source: ParsedSource,
  methodWeb: ReadonlyMap<string, readonly DecoratorUse[]>,
  inputs: ControllerRouteInputs,
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
    inputs.throwsContext,
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
    reportOrphanMethodDirectives(methodWeb, method, diagnostics);
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
  if (reportLegacySchemaArguments(routeDecorators, diagnostics)) {
    return;
  }
  const handlerName = validRouteHandlerMethod(method, controllerName, diagnostics);
  if (handlerName === undefined) {
    return;
  }
  const directives = routeResponseDirectivesOf(scan.source, methodWeb, inputs, diagnostics);
  if (directives === undefined) {
    return;
  }
  const contract = resolveRouteSlots({
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
    responseDirectives: directives.response,
  });
  if (contract === undefined) {
    return;
  }
  const routeUse = useTargetsOf(
    scan.source,
    methodWeb.get("Use") ?? [],
    inputs.middlewareById,
    inputs.linker,
    diagnostics,
  );
  const middleware = flattenedChain(inputs.globalMiddleware, controllerUse, routeUse);
  const throws = unionThrows([
    directives.throws,
    ...middleware.map((entry) => inputs.middlewareThrows.get(entry.beanId) ?? []),
  ]);
  pushRouteCandidates(inputs, {
    routeDecorators,
    basePath,
    claim,
    handlerName,
    contract,
    throws,
    middleware,
    meta: routeMetaOf(scan.source, method, inputs.markers, inputs.linker, diagnostics),
  });
}

interface RouteCandidateInputs {
  readonly routeDecorators: readonly (readonly [string, readonly DecoratorUse[]])[];
  readonly basePath: string;
  readonly claim: WebBeanClaim;
  readonly handlerName: string;
  readonly contract: RouteContractModel;
  readonly throws: readonly RouteThrownErrorModel[];
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
        contract: candidateInputs.contract,
        throws: candidateInputs.throws,
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
  readonly contract: RouteContractModel;
  readonly throws: readonly RouteThrownErrorModel[];
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
  if (!decorator.called || decorator.arguments.length > 1) {
    report(
      diagnostics,
      "INVALID_ROUTE_DECLARATION",
      `${inputs.decoratorName} must be called with an optional path literal.`,
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
    !reportUnknownPathParameters(inputs.contract, pathInfo.path, pathInfo.parameters, diagnostics)
  ) {
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
      middleware: inputs.middleware,
      meta: inputs.meta,
      contract: inputs.contract,
      throws: inputs.throws,
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
