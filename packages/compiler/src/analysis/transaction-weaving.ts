import type { MethodMetaValueModel } from "@/analysis/interception-model";
import { markerUseValueOf } from "@/analysis/marker-value";
import { type ProviderDraft, sourceReference } from "@/analysis/model";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import { transactionFrameworkSymbol } from "@/linking/export-binding";
import type { LinkedSymbol } from "@/linking/model";
import type { ProjectLinker } from "@/linking/project-linker";
import type { DecoratorUse } from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

// @Transactional 的编译期词汇（ADR 0008 AM2，#204 定案 2/6）：框架标记走 AM1 标记通道零特权，
// 唯一的额外机器是这里——保留 key、参数 schema 校验、以及事务拦截器的合成注册。拦截器不让
// 用户手声明（starter meta v1 也没有拦截器槽位），编译器在检测到标记使用时替 @reforce/transaction
// 合成一条 registration，依赖边走正常契约解析：图中有使用但无 TransactionManager 实现
// 即编译期 MISSING_BEAN，不是运行时才炸。

export const transactionalMarkerKey = "transactional";

export const transactionInterceptorBeanId = "@reforce/transaction#TransactionInterceptor";

// manifest 的框架来源串（#204 定案 6）：与 starter 的 "pkg@version" 相区分，explain 按它
// 渲染 framework 词汇（cli/src/explain/render.ts 同一字面量）。
export const frameworkOriginId = "@reforce/transaction";

// 拦截器类型只从生成入口导出（transaction generated-runtime.ts 同注释）：契约 type-only import
// 与 registration 的值 import 都指向这里。
const transactionInterceptorRuntimeExport = {
  module: "@reforce/transaction/generated-runtime",
  export: "TransactionInterceptor",
} as const;

export const transactionInterceptorSymbol: LinkedSymbol = Object.freeze({
  key: "transaction:TransactionInterceptor",
  kind: "transaction",
  name: "TransactionInterceptor",
  moduleSpecifier: transactionInterceptorRuntimeExport.module,
  generic: false,
});

export const transactionManagerSymbol: LinkedSymbol =
  transactionFrameworkSymbol("TransactionManager");

// savepoint 能力表达在契约身份上（ADR 0008 T4 定案）：NESTED 使用处按这个符号解析依赖边，
// manager 没实现就是 MISSING_BEAN——与"图里根本没有 manager"同一种编译期诊断。
export const nestedTransactionManagerSymbol: LinkedSymbol = transactionFrameworkSymbol(
  "NestedTransactionManager",
);

// implements 一个框架契约时 push 出的契约符号集合。NestedTransactionManager 同时 push 两个
// 符号，显式建模 interface 的 extends 关系：用户可以在自己的 bean 构造函数里注入裸
// TransactionManager（落成 transaction:TransactionManager 的 pending dependency），只 push
// Nested 一个 key 的话这类注入点立刻 MISSING_BEAN——一个功能更全的 manager 反而装不上。
// context 符号走不到 expandProvidedInterface（那里只处理应用接口），继承关系必须手写。
//
// 同类写 implements TransactionManager, NestedTransactionManager 时由 dedupeSymbols 按 key
// 收敛；两个不同类分别实现两个接口时 transaction:TransactionManager 下 2 个候选 →
// AMBIGUOUS_BEAN，与现状一致、语义正确、@Primary 可解。
export function transactionManagerContractsOf(symbol: LinkedSymbol): readonly LinkedSymbol[] {
  if (symbol.name === nestedTransactionManagerSymbol.name) {
    return [symbol, transactionManagerSymbol];
  }
  if (symbol.name === transactionManagerSymbol.name) {
    return [symbol];
  }
  return [];
}

export function isTransactionalDecorator(
  source: ParsedSource,
  decorator: DecoratorUse,
  linker: ProjectLinker,
): boolean {
  if (decorator.callee.kind === "unsupported-expression") {
    return false;
  }
  const symbol = linker.resolveEntity(source, decorator.callee);
  return symbol?.kind === "transaction" && symbol.name === "Transactional";
}

interface TransactionalDemand {
  // 第一处 @Transactional 使用——"这个 bean 为什么在图里"的答案。
  readonly span: SourceSpan;
  // 整个项目里是否存在 propagation: "NESTED"。整图求值而非首处求值：合成拦截器只有一个，
  // 它依赖的 manager 契约必须覆盖项目里最强的需求。
  readonly nested: boolean;
}

function transactionalUsesInSource(
  source: ParsedSource,
  linker: ProjectLinker,
): readonly DecoratorUse[] {
  if (source.sourceKind.startsWith("d.")) {
    return [];
  }
  return source.unit.classes.flatMap((declaration) =>
    declaration.methods.flatMap((method) =>
      method.decorators.filter((use) => isTransactionalDecorator(source, use, linker)),
    ),
  );
}

function transactionalDemandOf(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
): TransactionalDemand | undefined {
  const uses = sources.flatMap((source) => transactionalUsesInSource(source, linker));
  const span = uses.at(0)?.span;
  return span === undefined
    ? undefined
    : { span, nested: uses.some((use) => declaresNestedPropagation(use)) };
}

// 扫描时顺便求值：DecoratorUse 在 parse 阶段就带 arguments，markerUseValueOf 是纯 IR 计算
// ——不需要 provider 表、不需要 markers 注册表、不需要 resolveProviders 的任何产物，因此
// analyze-project 的阶段顺序完全不动。诊断丢弃：权威诊断由 markedMethodOf 在织入分析里
// 产出（同一个 validateTransactionalValue），这里重复报会让同一处错误出现两遍。
function declaresNestedPropagation(use: DecoratorUse): boolean {
  const discarded: CompilerDiagnostic[] = [];
  const value = markerUseValueOf(use, discarded);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!validateTransactionalValue(value, use.span, discarded)) {
    return false;
  }
  return Reflect.get(value, "propagation") === "NESTED";
}

// 合成注册（#204 定案 6）：在 resolveProviders 之前入表，manager 契约经 pendingDependencies
// 走既有解析（MISSING_BEAN / AMBIGUOUS_BEAN / 本地恒胜全部免费）。declarationSource 与需求
// span 都指向第一处 @Transactional 使用——"这个 bean 为什么在图里"的答案就是把它拉进来的
// 那次使用。类级误用不产生需求：它在织入分析里硬错，编译必然失败。
export function transactionInterceptorDraft(
  sources: readonly ParsedSource[],
  linker: ProjectLinker,
): ProviderDraft | undefined {
  const demand = transactionalDemandOf(sources, linker);
  if (demand === undefined) {
    return undefined;
  }
  const { span, nested } = demand;
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
      // 合成的拦截器同样是角色 bean（bean-roles.ts）：它绕过用户装饰器入表，但"由框架调度、
      // 不可被谁注入"的规则与手写 @Interceptor 完全一致，靠的就是这个字段而不是反查装饰器。
      role: "interceptor",
      qualifiers: [],
      dependencies: [],
      startHook: false,
      closeHook: false,
    },
    pendingDependencies: [
      {
        index: 0,
        linkedType: {
          // NESTED 一出现，合成拦截器就改按 NestedTransactionManager 契约解析：manager 不
          // 支持 savepoint 时是编译期 MISSING_BEAN，而不是等运行时抛
          // TransactionSavepointUnsupportedError。
          symbol: nested ? nestedTransactionManagerSymbol : transactionManagerSymbol,
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
  "Use @Transactional() or @Transactional({ propagation?, isolation?, timeout? }) with literal values.";

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

// validOption 是为字符串枚举写的，timeout 的合法域是正整数毫秒，单独一条。
function validTimeout(
  value: MethodMetaValueModel,
  span: SourceSpan,
  diagnostics: CompilerDiagnostic[],
): boolean {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return true;
  }
  return reportInvalidValue(
    diagnostics,
    "Transactional timeout must be a positive integer number of milliseconds.",
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
    } else if (key === "timeout") {
      valid = validTimeout(entry, span, diagnostics) && valid;
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
