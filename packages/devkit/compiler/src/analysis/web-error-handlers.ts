import type { ProviderModel } from "@/analysis/model";
import { applicationClassTargetOf } from "@/analysis/web-class-target";
import {
  type ClassRoleScan,
  claimWebBean,
  responseStatusOf,
  singleCalledDecorator,
} from "@/analysis/web-decorators";
import type {
  ErrorAcceptsModel,
  ResponseContractModel,
  WebErrorHandlerModel,
} from "@/analysis/web-model";
import { createSlotResolutionContext } from "@/analysis/web-slot-context";
import { type ResponseStatusModel, resolveResponseDeclaration } from "@/analysis/web-slots";
import type { CompilerDiagnostic } from "@/api";
import { report } from "@/diagnostics";
import type { ProjectLinker } from "@/linking/project-linker";
import type { DecoratorUse, TypeNode } from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { TypeQuery } from "@/typescript/type-query";

// 错误处理器的登记与形状分析（#275；#363 独立成模块）：@ErrorHandler 类的 accepts 裁决、
// 响应声明解析与分派序。
//
// ErrorHandlerInfo 与 errorHandlerSignatureHelp 必须与 registerErrorHandler 同侧：@Throws 的
// 匹配要按 accepts 键查这份名录，也要复用同一条 help 文案。放到 throws 那侧就反了——登记
// 先于匹配发生，依赖方向只能是 throws → error-handlers。
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

export const errorHandlerSignatureHelp =
  "Typed error handlers declare handle as a method whose first parameter is annotated with an " +
  "exported, non-generic application error class; `unknown` (or a field-form handle) keeps the " +
  "handler match-all. @Throws additionally accepts a const created by defineHttpError(...) — " +
  "those errors carry their own status and code and need no handler.";

export interface ErrorHandlerInfo extends WebErrorHandlerModel {
  // 声明位:THROWS_WITHOUT_HANDLER 的 related span 点名已注册处理器。
  readonly span: SourceSpan;
}

// 错误处理器的类型分析接线(#275):handle 方法的 accepts 与响应声明都要查 checker。
export interface ErrorHandlerAnalysisInputs {
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

export function registerErrorHandler(
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
