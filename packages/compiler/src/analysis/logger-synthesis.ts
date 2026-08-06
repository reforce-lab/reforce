import { markerUseValueOf } from "@/analysis/marker-value";
import type { LiteralArgumentValue, PendingDependency, ProviderDraft } from "@/analysis/model";
import { sourceReference } from "@/analysis/model";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { LinkedSymbol } from "@/linking/model";
import type { ProjectLinker } from "@/linking/project-linker";
import type { DecoratorUse } from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";
import type { ParsedSource } from "@/project/source-files";

// logger bean 合成（RFC 0011 L2，#242）。
//
// 用户写 `constructor(private readonly log: Logger)`，编译器为每个 logger 名合成一条框架 bean，
// 把消费者那条依赖边直接指过去。名字是编译期事实，作为字面量构造实参内联进 beans.ts。
//
// **这是全设计唯一的解析特例**，所以它有名字：redirectedLoggerDependency。合成的 logger bean
// 刻意 `provides: []`——不进候选池。否则 N 个 logger 同时提供 Logger 契约，每条 Logger 边都会
// 是 AMBIGUOUS_BEAN。它们的消费者由重定向表点名，不经 selectProvider。

export const loggingPackageName = "@reforce/logging";
export const loggerContractName = "Logger";
export const loggerFactoryContractName = "LoggerFactory";
export const loggerNameDecoratorName = "LoggerName";

// 与 starter 的 "pkg@version" 相区分：框架来源串无版本段（#204 定案 6 的同一约定）。
export const loggingOriginId = loggingPackageName;

const boundLoggerRuntimeExport = {
  module: "@reforce/logging/generated-runtime",
  export: "BoundLogger",
} as const;

export function loggerBeanId(name: string): string {
  return `${loggingOriginId}#Logger(${name})`;
}

function isLoggingContract(symbol: LinkedSymbol, name: string): boolean {
  return symbol.external?.packageName === loggingPackageName && symbol.name === name;
}

export function isLoggerContract(symbol: LinkedSymbol): boolean {
  return isLoggingContract(symbol, loggerContractName);
}

function loggerFactorySymbolFrom(symbol: LinkedSymbol): LinkedSymbol {
  // 借消费者那条 Logger 边的符号造 LoggerFactory 契约符号：external 归属、moduleSpecifier
  // 都要与用户 import 到的那个包实例一致，手工拼一个会在多副本安装下指错包。
  return {
    ...symbol,
    key: symbol.key.replace(loggerContractName, loggerFactoryContractName),
    name: loggerFactoryContractName,
    generic: false,
  };
}

// @LoggerName 认的是 import 绑定，不是解析后的符号：它是个**函数**导出，而链接层只为
// class/interface 做外部归属（external），函数一律落成 kind "unsupported" 加一个不透明的
// external/<hash>.ts specifier——按符号根本认不出它来自哪个包。按 import 绑定认既精确又天然
// 支持改名导入（`import { LoggerName as Named }`）。
function loggerNameDecoratorLocals(source: ParsedSource): ReadonlySet<string> {
  const locals = new Set<string>();
  for (const declaration of source.unit.imports) {
    if (declaration.kind !== "import" || declaration.moduleSpecifier !== loggingPackageName) {
      continue;
    }
    for (const binding of declaration.bindings) {
      if (binding.kind === "named" && binding.imported === loggerNameDecoratorName) {
        locals.add(binding.local);
      }
    }
  }
  return locals;
}

function decoratedLoggerName(
  source: ParsedSource,
  decorators: readonly DecoratorUse[],
): string | undefined {
  const locals = loggerNameDecoratorLocals(source);
  if (locals.size === 0) {
    return undefined;
  }
  for (const use of decorators) {
    if (use.callee.kind !== "identifier" || !locals.has(use.callee.name)) {
      continue;
    }
    // 诊断丢弃：@LoggerName 只接一个字符串字面量，取不到就当没写、落回推导名。
    const discarded: CompilerDiagnostic[] = [];
    const value = markerUseValueOf(use, discarded);
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

interface LoggerDemand {
  readonly consumerId: string;
  readonly parameterIndex: number;
  readonly loggerName: string;
  readonly contract: LinkedSymbol;
  readonly span: SourceSpan;
}

function loggerNameOf(draft: ProviderDraft): string {
  const origin = draft.provider.origin;
  if (origin.kind === "application") {
    const declaration = origin.source.unit.classes.find(
      (item) => item.name === draft.provider.exportName,
    );
    const overridden =
      declaration === undefined
        ? undefined
        : decoratedLoggerName(origin.source, declaration.decorators);
    if (overridden !== undefined) {
      return overridden;
    }
  }
  // 缺省是消费者的短导出名：`OrderService` 而不是 `src/orders/order-service.ts#OrderService`。
  // 路径进名字会让日志随文件搬家而变，而 logger 名是被 grep 与告警规则依赖的稳定标识。
  return draft.provider.exportName;
}

function loggerDemandsOf(drafts: readonly ProviderDraft[]): readonly LoggerDemand[] {
  const demands: LoggerDemand[] = [];
  for (const draft of drafts) {
    for (const pending of draft.pendingDependencies) {
      if (pending.collection === true || !isLoggerContract(pending.linkedType.symbol)) {
        continue;
      }
      demands.push({
        consumerId: draft.provider.id,
        parameterIndex: pending.index,
        loggerName: loggerNameOf(draft),
        contract: pending.linkedType.symbol,
        span: pending.sourceSpan,
      });
    }
  }
  return demands;
}

export function redirectKey(consumerId: string, parameterIndex: number): string {
  return `${consumerId}#${parameterIndex}`;
}

function reportDuplicateName(
  diagnostics: CompilerDiagnostic[],
  name: string,
  first: LoggerDemand,
  second: LoggerDemand,
): void {
  diagnostics.push(
    diagnostic({
      code: "DUPLICATE_LOGGER_NAME",
      message: `Two classes both resolve to the logger name "${name}".`,
      sourceSpan: second.span,
      related: [
        { message: `${first.consumerId} takes this name`, sourceSpan: first.span },
        { message: `${second.consumerId} takes it too`, sourceSpan: second.span },
      ],
      help: `Logger names identify a stream in the log output, so two classes sharing one is almost always accidental. Give one of them @${loggerNameDecoratorName}("…").`,
    }),
  );
}

export interface LoggerSynthesis {
  readonly drafts: readonly ProviderDraft[];
  /** `${consumerId}#${parameterIndex}` → logger bean id。 */
  readonly redirects: ReadonlyMap<string, string>;
  /** 编译期见到的全部 logger 名，升序；LoggerLevels 的封闭名单。 */
  readonly names: readonly string[];
}

export function synthesizeLoggerBeans(input: {
  readonly drafts: readonly ProviderDraft[];
  readonly linker: ProjectLinker;
  readonly diagnostics: CompilerDiagnostic[];
}): LoggerSynthesis {
  const demands = loggerDemandsOf(input.drafts);
  if (demands.length === 0) {
    return { drafts: [], redirects: new Map(), names: [] };
  }
  const byName = new Map<string, LoggerDemand>();
  const redirects = new Map<string, string>();
  for (const demand of demands) {
    const existing = byName.get(demand.loggerName);
    if (existing !== undefined && existing.consumerId !== demand.consumerId) {
      reportDuplicateName(input.diagnostics, demand.loggerName, existing, demand);
      continue;
    }
    byName.set(demand.loggerName, existing ?? demand);
    redirects.set(
      redirectKey(demand.consumerId, demand.parameterIndex),
      loggerBeanId(demand.loggerName),
    );
  }
  const names = [...byName.keys()].sort();
  return {
    drafts: names.map((name) => loggerDraft(name, byName.get(name))),
    redirects,
    names,
  };
}

function loggerDraft(name: string, demand: LoggerDemand | undefined): ProviderDraft {
  if (demand === undefined) {
    throw new Error(`Logger name ${name} lost its demand between collection and synthesis.`);
  }
  const factoryDependency: PendingDependency = {
    index: 0,
    linkedType: {
      // LoggerFactory 走正常解析：MISSING_BEAN / AMBIGUOUS_BEAN / 本地恒胜全部免费继承。
      // 没装任何绑定就是编译期 MISSING_BEAN，而不是运行时才发现没人写日志。
      symbol: loggerFactorySymbolFrom(demand.contract),
      typeArguments: [],
      lazy: false,
      current: false,
      span: demand.span,
    },
    sourceSpan: demand.span,
  };
  return {
    provider: {
      kind: "class",
      id: loggerBeanId(name),
      origin: {
        kind: "framework",
        origin: loggingOriginId,
        runtimeExport: boundLoggerRuntimeExport,
        sourceText: `${boundLoggerRuntimeExport.module}#${boundLoggerRuntimeExport.export}`,
      },
      // exportName 是 bean 身份的一段，不是运行导出名：一个导出（BoundLogger）承载 N 个 bean
      // 身份，这是框架 logger 独有的形态，manifest 校验为它单开一条分支。
      exportName: `Logger(${name})`,
      // 「这个 bean 为什么在图里」的答案就是第一处注入它的构造参数。
      declarationSource: sourceReference(demand.span),
      // 刻意为空：不进候选池。消费者由重定向表点名，见本文件顶部。
      provides: [],
      scope: "singleton",
      primary: false,
      qualifiers: [],
      dependencies: [],
      literalArguments: [{ index: 1, value: name satisfies LiteralArgumentValue }],
      startHook: false,
      closeHook: false,
    },
    pendingDependencies: [factoryDependency],
  };
}
