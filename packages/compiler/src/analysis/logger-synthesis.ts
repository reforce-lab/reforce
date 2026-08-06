import { markerUseValueOf } from "@/analysis/marker-value";
import type {
  GeneratedSourceReferenceModel,
  LiteralArgumentValue,
  PendingDependency,
  ProviderDraft,
} from "@/analysis/model";
import { sourceReference } from "@/analysis/model";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { LinkedSymbol } from "@/linking/model";
import type { ProjectLinker } from "@/linking/project-linker";
import type { DecoratorUse } from "@/parser/source-ir";
import type { CanonicalFileId, SourceSpan } from "@/parser/source-location";
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
export const loggerLevelsContractName = "LoggerLevels";
export const loggerNameDecoratorName = "LoggerName";

// 与 starter 的 "pkg@version" 相区分：框架来源串无版本段（#204 定案 6 的同一约定）。
export const loggingOriginId = loggingPackageName;

const boundLoggerRuntimeExport = {
  module: "@reforce/logging/generated-runtime",
  export: "BoundLogger",
} as const;

const loggerLevelsRuntimeExport = {
  module: "@reforce/logging/generated-runtime",
  export: loggerLevelsContractName,
} as const;

/** 级别快照 bean：全图唯一一条，所以 id 是常量而不是按名字派生。 */
export const loggerLevelsBeanId = `${loggingOriginId}#${loggerLevelsContractName}`;

export function loggerBeanId(name: string): string {
  return `${loggingOriginId}#Logger(${name})`;
}

function isLoggingContract(symbol: LinkedSymbol, name: string): boolean {
  return symbol.external?.packageName === loggingPackageName && symbol.name === name;
}

export function isLoggerContract(symbol: LinkedSymbol): boolean {
  return isLoggingContract(symbol, loggerContractName);
}

export function isLoggerFactoryContract(symbol: LinkedSymbol): boolean {
  return isLoggingContract(symbol, loggerFactoryContractName);
}

// LoggerLevels 与 Logger 同属那条解析特例：合成的 bean 刻意 provides 为空，边由**符号身份**
// 点名而不是走候选池。两者的区别只在多重性——每个消费者一条自己的 Logger，而 LoggerLevels
// 全图共用一条，所以它不需要逐消费者的重定向表，认出符号就够了。
//
// 按包名 + 名字认而不是按 key 认，是因为绑定可能来自 starter（pino 的 meta 边从 starter 包根
// 解析）也可能来自应用源集（用户自写的 LoggerFactory），两条路径给出的 key 属于不同锚点，
// 而它们指的是同一个契约。
export function isLoggerLevelsContract(symbol: LinkedSymbol): boolean {
  return isLoggingContract(symbol, loggerLevelsContractName);
}

// 优先取图里真实存在的那个 LoggerFactory 契约符号——绑定 bean（starter 的 PinoLoggerFactory、
// 或用户自己 implements 的类）的 provides 里就有。这比从 Logger 边推导可靠：多副本安装下
// external 归属必须与提供方逐字一致，否则合成的依赖边指向另一份包实例，落成 MISSING_BEAN。
function providedLoggerFactorySymbol(
  drafts: readonly ProviderDraft[],
  linker: ProjectLinker,
): LinkedSymbol | undefined {
  for (const draft of drafts) {
    const local = draft.provider.provides.find(isLoggerFactoryContract);
    if (local !== undefined) {
      return local;
    }
  }
  for (const bean of linker.starterLinkage.beans) {
    const provided = bean.provides.find(isLoggerFactoryContract);
    if (provided !== undefined) {
      return provided;
    }
  }
  return undefined;
}

// 图里没有任何绑定时的退路：借消费者那条 Logger 边的符号改名段。改的必须是**名字那一段**——
// key 的形状是 `<fileId>#<kind>:<name>`，整串 replace("Logger") 会命中路径里先出现的同形
// 片段（`.../MyLoggerApp/node_modules/...`），把 key 换成一个谁也解析不到的东西。
// 走到这条路径的结果注定是 LoggerFactory 的 MISSING_BEAN，而这正是想要的：注入了 Logger
// 却没装任何绑定，是编译期错误，不是运行时才发现没人写日志。
function loggerFactorySymbolFrom(symbol: LinkedSymbol): LinkedSymbol {
  const key = symbol.key.endsWith(loggerContractName)
    ? `${symbol.key.slice(0, -loggerContractName.length)}${loggerFactoryContractName}`
    : `${symbol.key}:${loggerFactoryContractName}`;
  return { ...symbol, key, name: loggerFactoryContractName, generic: false };
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

/** 框架自己那条 logger：请求日志与引擎监听行都从它出（RFC 0011 L6/L8，#250）。 */
export const webFrameworkLoggerName = "reforce.web";

export const webFrameworkLoggerBeanId = loggerBeanId(webFrameworkLoggerName);

// metaSource 与 SourceSpan 逐字段同构（差一个 file/fileId 的名字），所以这是改名不是伪造位置。
// 框架 logger 没有用户源码位置，「它为什么在图里」的答案就是那条注册了 web 引擎的 starter meta
// 条目——与引擎 bean 自己的 declarationSource 指向同一处。
function spanOfMetaSource(source: GeneratedSourceReferenceModel): SourceSpan {
  // file 出自 starter 链接阶段，已满足 canonical 相对路径文法 // justified: 品牌只记录该校验
  const fileId = source.file as CanonicalFileId;
  return { fileId, start: source.start, end: source.end };
}

interface LoggerDemand {
  readonly consumerId: string;
  readonly parameterIndex: number;
  readonly loggerName: string;
  readonly span: SourceSpan;
  /** 用户注入点那条 Logger 边的契约符号；框架 logger 没有消费者，缺席。 */
  readonly contract?: LinkedSymbol;
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

/** 编译器自己点名要的一条 logger（不来自任何构造参数）。 */
export interface FrameworkLoggerRequest {
  readonly name: string;
  /** 撞名诊断里指代请求方的文字，例如 `@reforce/web`。 */
  readonly reason: string;
  /** 把它拉进图里的那条 starter meta 条目。 */
  readonly source: GeneratedSourceReferenceModel;
}

export interface LoggerSynthesis {
  readonly drafts: readonly ProviderDraft[];
  /** `${consumerId}#${parameterIndex}` → logger bean id。 */
  readonly redirects: ReadonlyMap<string, string>;
  /** 编译期见到的全部 logger 名，升序；LoggerLevels 的封闭名单。 */
  readonly names: readonly string[];
  /** 合成了级别快照 bean 时给出它的 id；图里没有日志时缺席，LoggerLevels 边照旧 MISSING_BEAN。 */
  readonly levelsBeanId?: string;
}

/** 编译期可见的级别配置（`.env` 那几层，RFC 0011 L5 表前两行）。 */
export interface CompileTimeLoggerLevels {
  /** `LOGGING_LEVEL_*` 的原始值，键是环境变量名。 */
  readonly values: ReadonlyMap<string, string>;
  /** 编译期实际读过的层，按读取顺序；启动时比对 REFORCE_PROFILE 偏斜用。 */
  readonly layers: readonly string[];
}

const logLevelNames = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

// 与 @reforce/logging 的 parseLogLevel 同一套判据。不 import 过来：编译器不依赖它分析的包，
// 而级别名是六个字面量的封闭集合，重复的是常量不是知识（DRY 认的是「改一处要同步多处」，
// 这份名单真要变，@reforce/logging 的公开类型本身就是破坏性变更）。
function parseLogLevel(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return logLevelNames.find((level) => level === normalized);
}

// 与运行期的 environmentKeyForLogger 逐字一致（analysis/logger-levels.ts 有同一份实现，那边
// 服务拼写校验、这边服务快照构造）。
function environmentKeyForLogger(name: string): string {
  return `LOGGING_LEVEL_${name.replaceAll(/[^A-Za-z0-9]/gu, "_").toUpperCase()}`;
}

// 快照只收**认得出**的级别：`.env` 里写了 `LOGGING_LEVEL_ORDERS=verbose` 时，把 "verbose"
// 原样内联进生成物等于让运行期拿到一个非 LogLevel 的字符串，落进 pino 会直接抛。丢掉它并
// 落回绑定缺省，与运行期 parseLogLevel 遇到坏值时的行为一致。
function levelsSnapshotFor(
  names: readonly string[],
  compileTime: CompileTimeLoggerLevels,
): Record<string, string> {
  const levels: Record<string, string> = {};
  for (const name of names) {
    const level = parseLogLevel(compileTime.values.get(environmentKeyForLogger(name)));
    if (level !== undefined) {
      levels[name] = level;
    }
  }
  return levels;
}

// 级别快照 bean（RFC 0011 L5，#249 的「未做」第一条）。它没有依赖边，全部内容是编译期算好的
// 字面量——封闭名单、逐 logger 级别、编译期读过的层。运行期的 process.env 那一层由
// LoggerLevels 自己在 levelFor 里叠加，不进快照：它是启动时才存在的事实。
function loggerLevelsDraft(
  names: readonly string[],
  compileTime: CompileTimeLoggerLevels,
  span: SourceSpan,
): ProviderDraft {
  const snapshot = {
    names,
    levels: levelsSnapshotFor(names, compileTime),
    // 兜底级别不从 .env 猜：绑定自己的缺省（PinoSettings.level / defaultLevel）是用户显式
    // 写下的，快照给一个"info"会把它顶掉。这里的 info 只在绑定也没有缺省时才轮得到。
    defaultLevel: "info",
    layers: compileTime.layers,
  } satisfies LiteralArgumentValue;
  return {
    provider: {
      kind: "class",
      id: loggerLevelsBeanId,
      origin: {
        kind: "framework",
        origin: loggingOriginId,
        runtimeExport: loggerLevelsRuntimeExport,
        sourceText: `${loggerLevelsRuntimeExport.module}#${loggerLevelsRuntimeExport.export}`,
      },
      exportName: loggerLevelsContractName,
      declarationSource: sourceReference(span),
      // 与 logger bean 同理刻意为空：消费者由 isLoggerLevelsContract 点名，不经 selectProvider。
      provides: [],
      scope: "singleton",
      primary: false,
      qualifiers: [],
      dependencies: [],
      literalArguments: [{ index: 0, value: snapshot }],
      startHook: false,
      closeHook: false,
    },
    pendingDependencies: [],
  };
}

// 框架 logger 与用户 logger 的区别只在「谁把它拉进图里」：用户那条是构造参数，框架这条是
// 「装了 web 引擎」。名字撞上时用户赢——`@LoggerName("reforce.web")` 是显式意图，框架不该覆盖它。
function frameworkDemandsOf(
  requested: readonly FrameworkLoggerRequest[],
  taken: ReadonlyMap<string, LoggerDemand>,
): readonly LoggerDemand[] {
  return requested
    .filter((request) => !taken.has(request.name))
    .map((request) => ({
      // 框架 logger 没有消费者：consumerId 只用于撞名诊断的定位文案，这里给出请求方身份。
      consumerId: request.reason,
      parameterIndex: -1,
      loggerName: request.name,
      span: spanOfMetaSource(request.source),
    }));
}

// 名字 → 第一个要它的消费者，外加消费者那条边的重定向表。同一个消费者重复注入 Logger 不是
// 撞名（它本来就只有一条 logger），所以判据是 consumerId 而不是「名字已存在」。
function collectLoggerDemands(
  demands: readonly LoggerDemand[],
  diagnostics: CompilerDiagnostic[],
): {
  readonly byName: Map<string, LoggerDemand>;
  readonly redirects: Map<string, string>;
} {
  const byName = new Map<string, LoggerDemand>();
  const redirects = new Map<string, string>();
  for (const demand of demands) {
    const existing = byName.get(demand.loggerName);
    if (existing !== undefined && existing.consumerId !== demand.consumerId) {
      reportDuplicateName(diagnostics, demand.loggerName, existing, demand);
      continue;
    }
    byName.set(demand.loggerName, existing ?? demand);
    redirects.set(
      redirectKey(demand.consumerId, demand.parameterIndex),
      loggerBeanId(demand.loggerName),
    );
  }
  return { byName, redirects };
}

export function synthesizeLoggerBeans(input: {
  readonly drafts: readonly ProviderDraft[];
  readonly linker: ProjectLinker;
  readonly diagnostics: CompilerDiagnostic[];
  /** 编译器自己要的 logger（框架输出面）；只有图里真有绑定时才合成。 */
  readonly frameworkLoggers?: readonly FrameworkLoggerRequest[];
  /** 编译期可见的级别配置，进 LoggerLevels 快照的字面量实参。 */
  readonly compileTimeLevels: CompileTimeLoggerLevels;
}): LoggerSynthesis {
  const demands = loggerDemandsOf(input.drafts);
  const provided = providedLoggerFactorySymbol(input.drafts, input.linker);
  const { byName, redirects } = collectLoggerDemands(demands, input.diagnostics);
  // 没有任何绑定时不合成框架 logger：那样等于替一个从没打算写日志的应用凭空造一条
  // LoggerFactory 的 MISSING_BEAN。用户自己注入 Logger 是另一回事——那是他要求的，报错正确。
  if (provided !== undefined) {
    for (const demand of frameworkDemandsOf(input.frameworkLoggers ?? [], byName)) {
      byName.set(demand.loggerName, demand);
    }
  }
  // 全部 logger 共用同一个 LoggerFactory 契约符号：图里真有提供方就用提供方那个，否则从
  // 用户的 Logger 边推导（结局是 MISSING_BEAN，正是想要的）。两者都没有就是「既没绑定也
  // 没人注入」，无事可做。
  const borrowed = demands.at(0)?.contract;
  const factorySymbol =
    provided ?? (borrowed === undefined ? undefined : loggerFactorySymbolFrom(borrowed));
  if (factorySymbol === undefined || byName.size === 0) {
    return { drafts: [], redirects, names: [] };
  }
  const names = [...byName.keys()].sort();
  // 快照 bean 的「为什么在图里」跟第一条 logger 同源：有 logger 才有级别可调。名字升序取第一条
  // 而不是 demands 的原序，是为了让同一份源码每次编译落在同一个 span 上。
  const levelsSpan = byName.get(names[0] ?? "")?.span;
  return {
    drafts: [
      ...names.map((name) => loggerDraft(name, byName.get(name), factorySymbol)),
      ...(levelsSpan === undefined
        ? []
        : [loggerLevelsDraft(names, input.compileTimeLevels, levelsSpan)]),
    ],
    redirects,
    names,
    ...(levelsSpan === undefined ? {} : { levelsBeanId: loggerLevelsBeanId }),
  };
}

function loggerDraft(
  name: string,
  demand: LoggerDemand | undefined,
  factorySymbol: LinkedSymbol,
): ProviderDraft {
  if (demand === undefined) {
    throw new Error(`Logger name ${name} lost its demand between collection and synthesis.`);
  }
  const factoryDependency: PendingDependency = {
    index: 0,
    linkedType: {
      // LoggerFactory 走正常解析：MISSING_BEAN / AMBIGUOUS_BEAN / 本地恒胜全部免费继承。
      // 没装任何绑定就是编译期 MISSING_BEAN，而不是运行时才发现没人写日志。
      symbol: factorySymbol,
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
