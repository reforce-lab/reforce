import type { MethodMetaValueModel } from "@/analysis/interception-model";
import { type ProviderDraft, sourceReference } from "@/analysis/model";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import { contextFrameworkSymbol } from "@/linking/export-binding";
import type { LinkedSymbol } from "@/linking/model";
import type { ProjectLinker } from "@/linking/project-linker";
import type { DecoratorUse } from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

// @Transactional 的编译期词汇（ADR 0008 AM2，#204 定案 2/6）：框架标记走 AM1 标记通道零特权，
// 唯一的额外机器是这里——保留 key、参数 schema 校验、以及事务拦截器的合成注册。拦截器不让
// 用户手声明（starter meta v1 也没有拦截器槽位），编译器在检测到标记使用时替 @reforce/context
// 合成一条 registration，依赖边走正常契约解析：图中有使用但无 TransactionManager 实现
// 即编译期 MISSING_BEAN，不是运行时才炸。

export const transactionalMarkerKey = "transactional";

export const transactionInterceptorBeanId = "@reforce/context#TransactionInterceptor";

// manifest 的框架来源串（#204 定案 6）：与 starter 的 "pkg@version" 相区分，explain 按它
// 渲染 framework 词汇（cli/src/explain/render.ts 同一字面量）。
export const frameworkOriginId = "@reforce/context";

// 拦截器类型只从生成入口导出（context generated-runtime.ts 同注释）：契约 type-only import
// 与 registration 的值 import 都指向这里。
const transactionInterceptorRuntimeExport = {
  module: "@reforce/context/generated-runtime",
  export: "TransactionInterceptor",
} as const;

export const transactionInterceptorSymbol: LinkedSymbol = Object.freeze({
  key: "context:TransactionInterceptor",
  kind: "context",
  name: "TransactionInterceptor",
  moduleSpecifier: transactionInterceptorRuntimeExport.module,
  generic: false,
});

export const transactionManagerSymbol: LinkedSymbol = contextFrameworkSymbol("TransactionManager");

export function isTransactionalDecorator(
  source: ParsedSource,
  decorator: DecoratorUse,
  linker: ProjectLinker,
): boolean {
  if (decorator.callee.kind === "unsupported-expression") {
    return false;
  }
  const symbol = linker.resolveEntity(source, decorator.callee);
  return symbol?.kind === "context" && symbol.name === "Transactional";
}

function firstTransactionalUseSpan(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
): SourceSpan | undefined {
  for (const source of sources) {
    if (source.sourceKind.startsWith("d.")) {
      continue;
    }
    for (const declaration of source.unit.classes) {
      for (const method of declaration.methods) {
        const use = method.decorators.find((decorator) =>
          isTransactionalDecorator(source, decorator, linker),
        );
        if (use !== undefined) {
          return use.span;
        }
      }
    }
  }
  return undefined;
}

// 合成注册（#204 定案 6）：在 resolveProviders 之前入表，manager 契约经 pendingDependencies
// 走既有解析（MISSING_BEAN / AMBIGUOUS_BEAN / 本地恒胜全部免费）。declarationSource 与需求
// span 都指向第一处 @Transactional 使用——"这个 bean 为什么在图里"的答案就是把它拉进来的
// 那次使用。类级误用不产生需求：它在织入分析里硬错，编译必然失败。
export function transactionInterceptorDraft(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
): ProviderDraft | undefined {
  const span = firstTransactionalUseSpan(sources, linker);
  if (span === undefined) {
    return undefined;
  }
  return {
    provider: {
      kind: "class",
      id: transactionInterceptorBeanId,
      origin: {
        kind: "framework",
        origin: frameworkOriginId,
        runtimeExport: transactionInterceptorRuntimeExport,
        sourceText: `${transactionInterceptorRuntimeExport.module}#${transactionInterceptorRuntimeExport.export}`,
      },
      exportName: transactionInterceptorRuntimeExport.export,
      declarationSource: sourceReference(span),
      provides: [transactionInterceptorSymbol],
      scope: "singleton",
      primary: false,
      qualifiers: [],
      dependencies: [],
      startHook: false,
      closeHook: false,
    },
    pendingDependencies: [
      {
        index: 0,
        linkedType: {
          symbol: transactionManagerSymbol,
          typeArguments: [],
          lazy: false,
          current: false,
          span,
        },
        sourceSpan: span,
      },
    ],
  };
}

const transactionPropagations = ["REQUIRED", "REQUIRES_NEW", "NESTED"] as const;
const transactionIsolations = [
  "READ_UNCOMMITTED",
  "READ_COMMITTED",
  "REPEATABLE_READ",
  "SERIALIZABLE",
] as const;

const transactionalValueHelp =
  "Use @Transactional() or @Transactional({ propagation?, isolation? }) with literal values.";

function reportInvalidValue(
  diagnostics: CompilerDiagnostic[],
  message: string,
  span: SourceSpan,
): false {
  diagnostics.push(
    diagnostic({
      code: "INVALID_TRANSACTIONAL_VALUE",
      message,
      sourceSpan: span,
      help: transactionalValueHelp,
    }),
  );
  return false;
}

function validOption(
  values: readonly string[],
  option: string,
  value: MethodMetaValueModel,
  span: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): boolean {
  if (typeof value === "string" && values.includes(value)) {
    return true;
  }
  return reportInvalidValue(
    diagnostics,
    `Transactional ${option} must be one of ${values.map((entry) => JSON.stringify(entry)).join(", ")}.`,
    span,
  );
}

// 传播行为是编译期已知属性（ADR 0008 不变量 4）：schema 在这里钉死，运行时按表执行零决策；
// 运行时守卫（readTransactionalValue）只兜未经编译的调用方。0 参裸调用（null）合法。
export function validateTransactionalValue(
  value: MethodMetaValueModel | null,
  span: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): boolean {
  if (value === null) {
    return true;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return reportInvalidValue(
      diagnostics,
      "Transactional accepts one object literal of options.",
      span,
    );
  }
  let valid = true;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "propagation") {
      valid = validOption(transactionPropagations, key, entry, span, diagnostics) && valid;
    } else if (key === "isolation") {
      valid = validOption(transactionIsolations, key, entry, span, diagnostics) && valid;
    } else {
      valid = reportInvalidValue(
        diagnostics,
        `Transactional options do not include "${key}".`,
        span,
      );
    }
  }
  return valid;
}
