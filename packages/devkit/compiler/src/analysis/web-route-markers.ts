import { compareUtf16CodeUnits } from "@reforce/primitives";
import type { RouteMetaValueModel } from "@/analysis/web-model";
import type { CompilerDiagnostic } from "@/api";
import { report } from "@/diagnostics";
import type { ProjectLinker } from "@/linking/project-linker";
import type {
  ClassMethodDeclaration,
  DecoratorArgumentValue,
  DecoratorUse,
  ObjectLiteralProperty,
  ValueDeclaration,
} from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

// 路由 marker 的声明侧与使用侧（ADR 0006 W3 待打磨项定案，#152；#363 独立成模块）：
// defineRouteMarker 的顶层 const 收集、key 空间去重，以及 marker 值的 JSON 字面量提取。
//
// 与 web-route-path 是同层的两个独立话题，互不 import：路径讲的是注册键，marker 讲的是
// 挂在注册上的元数据。
const markerDeclarationHelp =
  'Declare route markers as export const X = defineRouteMarker<T>("key") with a non-empty string literal key.';

const markerValueHelp =
  "Route marker values must be static JSON literals: string, number, boolean, null, array, or object literals.";

export interface RouteMarkerDeclarationInfo {
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

export function collectRouteMarkers(
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
export function routeMetaOf(
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
