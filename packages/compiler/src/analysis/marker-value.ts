import type { MethodMetaValueModel } from "@/analysis/interception-model";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type {
  DecoratorArgumentValue,
  DecoratorUse,
  ObjectLiteralProperty,
} from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";

// 标记字面量的读取原语（#202 硬错 #7）：从 method-interception 抽出来单列，因为
// transaction-weaving 也要读——它在合成拦截器时要知道项目里有没有 NESTED 传播，才能决定
// 依赖 TransactionManager 还是 NestedTransactionManager 契约。两处各写一遍就会漂移，而
// 让 transaction-weaving 反向 import method-interception 会成环（后者已依赖前者的保留 key）。
//
// 纯 IR 计算：不需要 provider 表、不需要 markers 注册表、不需要 resolveProviders 的任何
// 产物，因此调用方可以在 analyze-project 的任何阶段使用它。

export const markerValueHelp =
  "Method marker values must be static JSON literals: string, number, boolean, null, array, or object literals.";

function reportInvalidMarkerValue(
  diagnostics: CompilerDiagnostic[],
  message: string,
  span: SourceSpan,
): undefined {
  diagnostics.push(
    diagnostic({
      code: "INVALID_METHOD_MARKER_VALUE",
      message,
      sourceSpan: span,
      help: markerValueHelp,
    }),
  );
  return undefined;
}

function markerMetaNumberOf(
  value: number,
  span: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): number | undefined {
  if (Number.isFinite(value)) {
    return value;
  }
  return reportInvalidMarkerValue(
    diagnostics,
    "Method marker numbers must be finite to serialize into the weaving table.",
    span,
  );
}

function markerMetaArrayOf(
  elements: readonly DecoratorArgumentValue[],
  diagnostics: CompilerDiagnostic[],
): MethodMetaValueModel | undefined {
  const lowered: MethodMetaValueModel[] = [];
  for (const element of elements) {
    const value = markerMetaValueOf(element, diagnostics);
    if (value === undefined) {
      return undefined;
    }
    lowered.push(value);
  }
  return lowered;
}

function markerMetaObjectOf(
  properties: readonly ObjectLiteralProperty[],
  diagnostics: CompilerDiagnostic[],
): MethodMetaValueModel | undefined {
  const lowered: Record<string, MethodMetaValueModel> = {};
  for (const property of properties) {
    if (property.kind === "unsupported-property") {
      return reportInvalidMarkerValue(
        diagnostics,
        `Method marker objects cannot use ${property.propertyKind} properties.`,
        property.span,
      );
    }
    const value = markerMetaValueOf(property.value, diagnostics);
    if (value === undefined) {
      return undefined;
    }
    lowered[property.key] = value;
  }
  return lowered;
}

// marker 值 = JSON 字面量树（#202 硬错 #7，metaValueOf 同口径）：静态可提取是硬边界。
export function markerMetaValueOf(
  value: DecoratorArgumentValue,
  diagnostics: CompilerDiagnostic[],
): MethodMetaValueModel | undefined {
  if (value.kind === "string-literal" || value.kind === "boolean-literal") {
    return value.value;
  }
  if (value.kind === "number-literal") {
    return markerMetaNumberOf(value.value, value.span, diagnostics);
  }
  if (value.kind === "null-literal") {
    return null;
  }
  if (value.kind === "array-literal") {
    return markerMetaArrayOf(value.elements, diagnostics);
  }
  if (value.kind === "object-literal") {
    return markerMetaObjectOf(value.properties, diagnostics);
  }
  return reportInvalidMarkerValue(
    diagnostics,
    "Method marker values must be statically extractable literals.",
    value.span,
  );
}

// 0/1 参门控（#202 对 W3 口径的唯一偏差）：裸调用是合法形态（@Transactional() 人体工学），
// 0 参记 null；未调用或多参硬错。
export function markerUseValueOf(
  decorator: DecoratorUse,
  diagnostics: CompilerDiagnostic[],
): MethodMetaValueModel | null | undefined {
  if (!decorator.called || decorator.arguments.length > 1) {
    return reportInvalidMarkerValue(
      diagnostics,
      "A method marker must be applied as a call with at most one literal value.",
      decorator.span,
    );
  }
  const argument = decorator.arguments.at(0);
  return argument === undefined ? null : markerMetaValueOf(argument, diagnostics);
}
