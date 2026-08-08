import { markerUseValueOf } from "@/analysis/marker-value";
import type {
  LiteralArgumentValue,
  PendingDependency,
  ProviderDraft,
  SourceReferenceModel,
} from "@/analysis/model";
import { sourceReference } from "@/analysis/model";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { LinkedSymbol } from "@/linking/model";
import type { ProjectLinker } from "@/linking/project-linker";
import type { StarterBeanModel } from "@/linking/starter-linking";
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
//
// ## L5b 的可行性结论（RFC 0011 要求「实现期给可行性结论」，#242）
//
// 问题：编译期能不能检出 `log.info({ user }, "logged in")` 这种「把整个实体塞进日志」的写法？
// **结论：不能，本波不做。** 但否决它的理由比 RFC 预设的早一层——
//
// RFC 假设风险在「需要一套『敏感』标记机制，那本身是新公开面」。真正第一个拦路的是：
// **编译器根本看不见调用点**。`ClassMethodDeclaration`（parser/source-ir.ts）只有
// parameterCount / returnType / decorators / span，没有方法体；`FunctionDescriptor.body` 也只
// 认得出 `direct-new`（工厂 bean 那一种），其余表达式一律落成 `unsupported`。也就是说
// `log.info(...)` 这个调用从来没有进过 Source IR，更谈不上分析它的实参形状。
//
// 补这一层要把语句与表达式全量下降进 Source IR。那不是加个字段：IR 的形状、体积与确定性
// 都要重新过一遍，而 CONTRIBUTING 规定 Parser-to-IR 测试断言整份 Source IR，等于全量重写
// 那批用例。代价与「多一条编译期告警」不成比例。
//
// 唯一现成的是**字段枚举**：`LinkedSymbol.declaration` 给得出 ClassDeclaration /
// InterfaceDeclaration，字段就在 IR 里。所以真要做，缺的是调用点这一半，不是类型这一半。
// 标记机制（RFC 点名的那条风险）排在第三位——前两条都过不去。

export const loggingPackageName = "@reforce/logging";

/**
 * Logger / LoggerFactory 的声明包（#347）。
 *
 * 它与 `loggingPackageName` **必须分开**：契约按角色沉到了引导层（@reforce/config 在容器不
 * 存在时就要 bootstrapLogger），而合成 bean 的 id、origin 与 runtimeExport 仍指 starter 包
 * ——那三样是产物字节的一部分，跟着契约搬会让全网 manifest 与 e2e 快照无谓地改一遍。
 *
 * 判据是「符号在哪声明」：@reforce/logging 把契约再导出一遍不改变归属，用户侧
 * `import { Logger } from "@reforce/logging"` 因此照旧解析到这里的包。
 */
export const loggingContractsPackageName = "@reforce/logging-contracts";
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

/** logger bean id 的定长前缀：emission 靠它认出合成的 logger（名字段是变的，前缀不是）。 */
export const loggerBeanIdPrefix = `${loggingOriginId}#${loggerContractName}`;

export function loggerBeanId(name: string): string {
  return `${loggerBeanIdPrefix}(${name})`;
}

function isLoggingContract(symbol: LinkedSymbol, packageName: string, name: string): boolean {
  return symbol.external?.packageName === packageName && symbol.name === name;
}

export function isLoggerContract(symbol: LinkedSymbol): boolean {
  return isLoggingContract(symbol, loggingContractsPackageName, loggerContractName);
}

export function isLoggerFactoryContract(symbol: LinkedSymbol): boolean {
  return isLoggingContract(symbol, loggingContractsPackageName, loggerFactoryContractName);
}

// LoggerLevels 与 Logger 同属那条解析特例：合成的 bean 刻意 provides 为空，边由**符号身份**
// 点名而不是走候选池。两者的区别只在多重性——每个消费者一条自己的 Logger，而 LoggerLevels
// 全图共用一条，所以它不需要逐消费者的重定向表，认出符号就够了。
//
// 按包名 + 名字认而不是按 key 认，是因为绑定可能来自 starter（pino 的 meta 边从 starter 包根
// 解析）也可能来自应用源集（用户自写的 LoggerFactory），两条路径给出的 key 属于不同锚点，
// 而它们指的是同一个契约。
// LoggerLevels 留在 starter 包，不随契约下沉：它的 bean 由编译器合成、runtimeExport 指
// `@reforce/logging/generated-runtime`，构造实参是编译期算好的名单——那是 starter 层的事实，
// 不是引导层的契约（#347）。
export function isLoggerLevelsContract(symbol: LinkedSymbol): boolean {
  return isLoggingContract(symbol, loggingPackageName, loggerLevelsContractName);
}

// 优先取图里真实存在的那个 LoggerFactory 契约符号——绑定 bean（starter 的 PinoLoggerFactory、
// 或用户自己 implements 的类）的 provides 里就有。这比从 Logger 边推导可靠：多副本安装下
// external 归属必须与提供方逐字一致，否则合成的依赖边指向另一份包实例，落成 MISSING_BEAN。
/** 绑定的契约符号，外加「它在哪」——框架 logger 的 span 就是这处绑定。 */
export interface ProvidedLoggerFactory {
  readonly symbol: LinkedSymbol;
  readonly span: SourceSpan;
  /** 绑定来自 starter 时进 manifest 的那份位置（包内相对）；来自应用源集时缺席，见 LoggerDemand。 */
  readonly source?: SourceReferenceModel;
}

export function providedLoggerFactorySymbol(
  drafts: readonly ProviderDraft[],
  linker: ProjectLinker,
): ProvidedLoggerFactory | undefined {
  for (const draft of drafts) {
    const local = draft.provider.provides.find(isLoggerFactoryContract);
    if (local !== undefined) {
      return { symbol: local, span: spanOfSourceReference(draft.provider.declarationSource) };
    }
  }
  for (const bean of linker.starterLinkage.beans) {
    const provided = bean.provides.find(isLoggerFactoryContract);
    if (provided !== undefined) {
      return { symbol: provided, span: spanOfStarterBean(bean), source: bean.metaSource };
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
  diagnostics: CompilerDiagnostic[],
): string | undefined {
  const locals = loggerNameDecoratorLocals(source);
  if (locals.size === 0) {
    return undefined;
  }
  for (const use of decorators) {
    if (use.callee.kind !== "identifier" || !locals.has(use.callee.name)) {
      continue;
    }
    // markerUseValueOf 自己的诊断丢弃、换成本码：它的文案说的是「method marker」，指不到
    // @LoggerName 的正确写法。
    const discarded: CompilerDiagnostic[] = [];
    const value = markerUseValueOf(use, discarded);
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    // 非字面量/空串是 error 不是静默回退：写了 @LoggerName 就是显式意图，静默落回推导名
    // 会让调级与告警规则对着一个不存在的名字，而编译期的安静让人以为改名生效了。
    diagnostics.push(
      diagnostic({
        code: "INVALID_DECORATOR_USAGE",
        message: `@${loggerNameDecoratorName} takes exactly one nonempty string literal.`,
        sourceSpan: use.span,
        help: `Write the logger name inline, e.g. @${loggerNameDecoratorName}("payments"); a computed name cannot be resolved at compile time.`,
      }),
    );
  }
  return undefined;
}

/** web 面那条 logger：请求日志、未命中与引擎监听行从它出（RFC 0011 L6/L8，#250）。 */
export const webFrameworkLoggerName = "reforce.web";

/**
 * 容器面那条 logger（RFC 0011 L6【已定】的两命名空间划分之一，另一条是 `reforce.web`）。
 * L6 的原词汇是 `reforce.context`；主包更名 @reforce/core 后命名空间随包名对齐为
 * `reforce.core`——破坏性改名，levels 里写旧名会被封闭名单当成未知名 warn 掉。
 * 启动摘要、bean 台账、关停与崩溃都归它——它们是容器的事实，不是 web 的，
 * 而且**非 web 应用（job / CLI / worker）同样要有**。有日志绑定就合成，与装没装引擎无关。
 */
export const contextFrameworkLoggerName = "reforce.core";

export const webFrameworkLoggerBeanId = loggerBeanId(webFrameworkLoggerName);

export const contextFrameworkLoggerBeanId = loggerBeanId(contextFrameworkLoggerName);

// 引导期 logger 不是 bean（bootstrapLogger 在运行时直接造），但对它调级是合法的：封闭名单
// 必须收它，否则 LoggingSettings.levels 写 "reforce.config" 会被启动期的未知名 warn 当成
// 拼错——而调它的级是合法动作，引导缓冲重放后由真 logger 按它过滤（RFC 0011 C4，#250）。
const bootstrapLoggerNames = ["reforce.config"] as const;

// SourceReferenceModel 与 SourceSpan 逐字段同构（差一个 file/fileId 的名字），所以这是改名
// 不是伪造位置。**只对应用侧的位置引用成立**：它们的 file 已经是项目根相对的。
export function spanOfSourceReference(source: SourceReferenceModel): SourceSpan {
  // file 出自项目源码发现，已满足 canonical 相对路径文法 // justified: 品牌只记录该校验
  const fileId = source.file as CanonicalFileId;
  return { fileId, start: source.start, end: source.end };
}

// starter bean 的位置引用是**包内**相对的，不能走上面那条——链接期为此另算了一份项目根相对的
// fileId（starter-linking 的 projectRelativeFileId，#369）。框架 logger 没有用户源码位置，
// 「它为什么在图里」的答案就是那条注册了引擎的 starter meta 条目。
export function spanOfStarterBean(bean: StarterBeanModel): SourceSpan {
  return { fileId: bean.metaSourceFileId, start: bean.metaSource.start, end: bean.metaSource.end };
}

interface LoggerDemand {
  readonly consumerId: string;
  readonly parameterIndex: number;
  readonly loggerName: string;
  readonly span: SourceSpan;
  /**
   * 进 manifest 的那份位置。缺席时由 span 换算——用户注入点的 span 本就是项目根相对的。
   *
   * starter 那侧必须显式给（#369）：它的 span 为了能被诊断渲染器解析成了**项目根**相对，
   * 而 manifest 里的路径要与机器无关，starter bean 的答案是**包内**相对的 metaSource。
   */
  readonly source?: SourceReferenceModel;
  /** 用户注入点那条 Logger 边的契约符号；框架 logger 没有消费者，缺席。 */
  readonly contract?: LinkedSymbol;
}

function loggerNameOf(draft: ProviderDraft, diagnostics: CompilerDiagnostic[]): string {
  const origin = draft.provider.origin;
  if (origin.kind === "application") {
    const declaration = origin.source.unit.classes.find(
      (item) => item.name === draft.provider.exportName,
    );
    const overridden =
      declaration === undefined
        ? undefined
        : decoratedLoggerName(origin.source, declaration.decorators, diagnostics);
    if (overridden !== undefined) {
      return overridden;
    }
  }
  // 缺省是消费者的短导出名：`OrderService` 而不是 `src/orders/order-service.ts#OrderService`。
  // 路径进名字会让日志随文件搬家而变，而 logger 名是被 grep 与告警规则依赖的稳定标识。
  return draft.provider.exportName;
}

function loggerDemandsOf(
  drafts: readonly ProviderDraft[],
  diagnostics: CompilerDiagnostic[],
): readonly LoggerDemand[] {
  const demands: LoggerDemand[] = [];
  for (const draft of drafts) {
    for (const pending of draft.pendingDependencies) {
      if (pending.collection === true || !isLoggerContract(pending.linkedType.symbol)) {
        continue;
      }
      demands.push({
        consumerId: draft.provider.id,
        parameterIndex: pending.index,
        loggerName: loggerNameOf(draft, diagnostics),
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
  /** 撞名诊断里指代请求方的文字，例如 `@reforce/web-core`。 */
  readonly reason: string;
  /** 把它拉进图里的那处位置：web 是 starter meta 条目，事务是第一处 @Transactional 使用。 */
  readonly span: SourceSpan;
  /** 进 manifest 的那份位置；缺席即由 span 换算。来自 starter 的请求必须给，见 LoggerDemand。 */
  readonly source?: SourceReferenceModel;
  /**
   * 有构造参数消费它时给出那条边（RFC 0011 C5，#250）。web 那条框架 logger 由生成的
   * bootstrap 直接 get，不经任何依赖边，所以缺席；事务拦截器则是按构造参数拿的。
   */
  readonly consumer?: {
    readonly beanId: string;
    readonly parameterIndex: number;
  };
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

// 级别快照 bean（RFC 0011 L5 勘误，#242）。它没有依赖边，全部内容是编译期算好的封闭名单：
// 级别的真相在 LoggingSettings bean 里，快照的职责收缩为「编译期看见了哪些名字」——供启动期
// 对 settings.levels 的键做确定性 did-you-mean。
function loggerLevelsDraft(names: readonly string[], demand: LoggerDemand): ProviderDraft {
  const snapshot = { names } satisfies LiteralArgumentValue;
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
      declarationSource: demand.source ?? sourceReference(demand.span),
      // 与 logger bean 同理刻意为空：消费者由 isLoggerLevelsContract 点名，不经 selectProvider。
      provides: [],
      scope: "singleton",
      primary: false,
      fallback: false,
      eager: false,
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
function applyFrameworkDemands(
  requested: readonly FrameworkLoggerRequest[],
  byName: Map<string, LoggerDemand>,
  redirects: Map<string, string>,
): void {
  for (const request of requested) {
    const demand = byName.get(request.name) ?? {
      // 框架 logger 没有构造参数消费者：consumerId 只用于撞名诊断的定位文案，这里给请求方身份。
      consumerId: request.reason,
      parameterIndex: -1,
      loggerName: request.name,
      span: request.span,
      ...(request.source === undefined ? {} : { source: request.source }),
    };
    byName.set(request.name, demand);
    if (request.consumer === undefined) {
      continue;
    }
    // 名字被用户的 @LoggerName 占了也照样设重定向：loggerBeanId(name) 两种情形下是同一个
    // id，消费者因此解析到用户那条 logger bean——正是「用户赢」该有的结果。跳过它反而会让
    // 那条边悬空，落成 TransactionLogger 的 MISSING_BEAN。
    redirects.set(
      redirectKey(request.consumer.beanId, request.consumer.parameterIndex),
      loggerBeanId(request.name),
    );
  }
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
      // 照设重定向：DUPLICATE_LOGGER_NAME 已经是这次撞名的完整报告，跳过重定向只会让第二
      // 消费者的 Logger 边悬空、再多一条指向不存在问题的 MISSING_BEAN 噪音。
      redirects.set(
        redirectKey(demand.consumerId, demand.parameterIndex),
        loggerBeanId(demand.loggerName),
      );
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
  /** 图里真实存在的 LoggerFactory 契约符号；由调用方查一次，避免两处各查一遍再各自漂移。 */
  readonly loggerFactory: LinkedSymbol | undefined;
  readonly diagnostics: CompilerDiagnostic[];
  /** 编译器自己要的 logger（框架输出面）；只有图里真有绑定时才合成。 */
  readonly frameworkLoggers?: readonly FrameworkLoggerRequest[];
}): LoggerSynthesis {
  const demands = loggerDemandsOf(input.drafts, input.diagnostics);
  const provided = input.loggerFactory;
  const { byName, redirects } = collectLoggerDemands(demands, input.diagnostics);
  // 没有任何绑定时不合成框架 logger：那样等于替一个从没打算写日志的应用凭空造一条
  // LoggerFactory 的 MISSING_BEAN。用户自己注入 Logger 是另一回事——那是他要求的，报错正确。
  if (provided !== undefined) {
    applyFrameworkDemands(input.frameworkLoggers ?? [], byName, redirects);
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
  // 有 bean 撑腰的 logger 名：只有它们能合成 BoundLogger draft，也只有它们有 span。
  const beanNames = [...byName.keys()].sort();
  // 级别名单还要收引导期 logger——它们没有 bean，但调得了级。
  const names = [...new Set([...beanNames, ...bootstrapLoggerNames])].sort();
  // 快照 bean 的「为什么在图里」跟第一条 logger 同源：有 logger 才有级别可调。名字升序取第一条
  // 而不是 demands 的原序，是为了让同一份源码每次编译落在同一个 span 上。
  //
  // span 只能从 beanNames 里取，不能从 names：引导期名字没有 demand，byName.get 返回
  // undefined，快照 bean 会连带整个不被合成，每条 LoggerLevels 边都变成 MISSING_BEAN。
  const levelsDemand = byName.get(beanNames[0] ?? "");
  return {
    drafts: [
      ...beanNames.map((name) => loggerDraft(name, byName.get(name), factorySymbol)),
      ...(levelsDemand === undefined ? [] : [loggerLevelsDraft(names, levelsDemand)]),
    ],
    redirects,
    names,
    ...(levelsDemand === undefined ? {} : { levelsBeanId: loggerLevelsBeanId }),
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
    // linkedType.span 喂诊断（渲染得出代码框），sourceSpan 进 manifest（必须与机器无关）：
    // 来自 starter 的需求两者不是同一条路径，见 LoggerDemand.source（#369）。
    sourceSpan: demand.source === undefined ? demand.span : spanOfSourceReference(demand.source),
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
      declarationSource: demand.source ?? sourceReference(demand.span),
      // 刻意为空：不进候选池。消费者由重定向表点名，见本文件顶部。
      provides: [],
      scope: "singleton",
      primary: false,
      fallback: false,
      eager: false,
      qualifiers: [],
      dependencies: [],
      literalArguments: [{ index: 1, value: name satisfies LiteralArgumentValue }],
      startHook: false,
      closeHook: false,
    },
    pendingDependencies: [factoryDependency],
  };
}
