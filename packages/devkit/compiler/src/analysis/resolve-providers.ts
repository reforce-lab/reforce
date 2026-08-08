import { compareUtf16CodeUnits } from "@reforce/primitives";
import { name as isIdentifierName } from "estree-util-is-identifier-name";
import { beanRoleSpecOf } from "@/analysis/bean-roles";
import {
  isLoggerFactoryContract,
  isLoggerLevelsContract,
  redirectKey,
} from "@/analysis/logger-synthesis";
import {
  type CollectionDependencyModel,
  type PendingDependency,
  type ProviderDraft,
  type ProviderModel,
  providerId,
  type QualifierModel,
  type SingleDependencyModel,
  sourceReference,
} from "@/analysis/model";
import type { CompilerDiagnostic } from "@/api";
import { diagnostic } from "@/diagnostics";
import type { LinkedSymbol } from "@/linking/model";
import type { StarterBeanModel, StarterLinkage } from "@/linking/starter-linking";
import type { NamespaceExportedMember } from "@/parser/source-ir";
import type { SourceSpan } from "@/parser/source-location";

type DiagnosticRelatedInformation = CompilerDiagnostic["related"][number];

const strictModuleReservedNames = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

function validQualifierName(name: string): boolean {
  return isIdentifierName(name) && !strictModuleReservedNames.has(name);
}

function validateBeanIdentities(
  drafts: readonly ProviderDraft[],
  diagnostics: CompilerDiagnostic[],
): void {
  const byPortableId = new Map<string, ProviderModel>();
  for (const draft of drafts) {
    const key = draft.provider.id.toLowerCase();
    const collision = byPortableId.get(key);
    if (collision === undefined) {
      byPortableId.set(key, draft.provider);
      continue;
    }
    diagnostics.push(
      diagnostic({
        code: "BEAN_ID_COLLISION",
        message: `Bean identity collides portably: ${draft.provider.id}.`,
        sourceSpan: providerSourceSpan(draft.provider),
        related: [{ message: collision.id }, { message: draft.provider.id }],
        help: "Rename one direct export or source so Bean IDs differ beyond letter case.",
      }),
    );
  }
}

// 链接候选：本地 provider 与（未物化的）starter bean 同表登记。选择规则见 ADR 0004（#120）
// 决策 11/12/13：本地恒胜；starter 里 defaultBean 在存在其他候选时退出；歧义与缺失都是硬错。
type CandidateEntry =
  | { readonly kind: "local"; readonly provider: ProviderModel }
  | { readonly kind: "starter"; readonly bean: StarterBeanModel };

interface CandidateIndex {
  readonly byKey: ReadonlyMap<string, readonly CandidateEntry[]>;
  readonly byCoordinate: ReadonlyMap<
    string,
    readonly { readonly key: string; readonly origin: string }[]
  >;
}

function indexCandidates(
  drafts: readonly ProviderDraft[],
  starterBeans: readonly StarterBeanModel[],
): CandidateIndex {
  const byKey = new Map<string, CandidateEntry[]>();
  const byCoordinate = new Map<string, { key: string; origin: string }[]>();
  const registerCoordinate = (symbol: LinkedSymbol, origin: string): void => {
    if (symbol.external === undefined) {
      return;
    }
    const entries = byCoordinate.get(symbol.external.coordinate) ?? [];
    if (!entries.some((entry) => entry.key === symbol.key && entry.origin === origin)) {
      entries.push({ key: symbol.key, origin });
    }
    byCoordinate.set(symbol.external.coordinate, entries);
  };
  for (const draft of drafts) {
    for (const provided of draft.provider.provides) {
      const existing = byKey.get(provided.key) ?? [];
      existing.push({ kind: "local", provider: draft.provider });
      byKey.set(provided.key, existing);
      registerCoordinate(provided, "application");
    }
  }
  for (const bean of starterBeans) {
    for (const provided of bean.provides) {
      const existing = byKey.get(provided.key) ?? [];
      existing.push({ kind: "starter", bean });
      byKey.set(provided.key, existing);
      registerCoordinate(provided, bean.origin);
    }
  }
  return { byKey, byCoordinate };
}

function providerSourceSpan(provider: ProviderModel): SourceSpan | undefined {
  if (provider.origin.kind !== "application") {
    return undefined;
  }
  return {
    fileId: provider.origin.source.fileId,
    start: provider.declarationSource.start,
    end: provider.declarationSource.end,
  };
}

function providerIdentityRelated(provider: ProviderModel): DiagnosticRelatedInformation {
  return { message: provider.id, sourceSpan: providerSourceSpan(provider) };
}

function qualifierAvailabilityRelated(
  drafts: readonly ProviderDraft[],
  interfaceKey: string,
  member?: string,
): readonly DiagnosticRelatedInformation[] {
  return drafts.flatMap((draft) =>
    draft.provider.qualifiers
      .filter(
        (qualifier) =>
          qualifier.interfaceSymbol.key === interfaceKey &&
          (member === undefined || qualifier.member === member) &&
          validQualifierName(qualifier.member),
      )
      .map((qualifier) => ({
        message: `${qualifier.member} -> ${draft.provider.id} (Primary: ${draft.provider.primary})`,
        sourceSpan: providerSourceSpan(draft.provider),
      })),
  );
}

function qualifierIndexKey(symbolKey: string, member: string): string {
  return `${symbolKey}\0${member}`;
}

function indexQualifiers(
  drafts: readonly ProviderDraft[],
  diagnostics: CompilerDiagnostic[],
): ReadonlyMap<string, ProviderModel> {
  const qualifierIndex = new Map<string, ProviderModel>();
  const reportedNamespaceCollisions = new Set<string>();
  for (const draft of drafts) {
    for (const qualifier of draft.provider.qualifiers) {
      if (!validQualifierName(qualifier.member)) {
        diagnostics.push(
          diagnostic({
            code: "INVALID_BEAN_QUALIFIER",
            message: `${qualifier.member} is not a valid non-reserved TypeScript identifier.`,
            help: "Choose a valid identifier for the qualifier member.",
          }),
        );
        continue;
      }
      const key = qualifierIndexKey(qualifier.interfaceSymbol.key, qualifier.member);
      const namespaceMember = qualifierNamespaceMember(qualifier);
      if (namespaceMember !== undefined && !reportedNamespaceCollisions.has(key)) {
        reportedNamespaceCollisions.add(key);
        diagnostics.push(
          diagnostic({
            code: "DUPLICATE_BEAN_QUALIFIER",
            message: `${qualifier.interfaceSymbol.name}.${qualifier.member} already exists in the source namespace.`,
            sourceSpan: namespaceMember.span,
            related: qualifierAvailabilityRelated(
              drafts,
              qualifier.interfaceSymbol.key,
              qualifier.member,
            ),
            help: "Rename the source namespace member or choose another Bean qualifier.",
          }),
        );
      }
      const collision = qualifierIndex.get(key);
      if (collision === undefined) {
        qualifierIndex.set(key, draft.provider);
        continue;
      }
      diagnostics.push(
        diagnostic({
          code: "DUPLICATE_BEAN_QUALIFIER",
          message: `${qualifier.interfaceSymbol.name}.${qualifier.member} is provided by multiple Beans.`,
          related: qualifierAvailabilityRelated(
            drafts,
            qualifier.interfaceSymbol.key,
            qualifier.member,
          ),
          help: "Assign distinct qualifier names within the interface.",
        }),
      );
    }
  }
  return qualifierIndex;
}

function qualifierNamespaceMember(qualifier: QualifierModel): NamespaceExportedMember | undefined {
  const source = qualifier.interfaceSymbol.source;
  if (source === undefined) {
    return undefined;
  }
  return source.unit.namespaces
    .filter(
      (namespace) =>
        namespace.topLevel &&
        namespace.export.kind === "named" &&
        namespace.name === qualifier.interfaceSymbol.name,
    )
    .flatMap((namespace) => namespace.exportedMembers)
    .find((member) => member.name === qualifier.member);
}

function validatePrimaryCandidates(
  candidates: CandidateIndex,
  diagnostics: CompilerDiagnostic[],
): void {
  for (const [symbolKey, entries] of candidates.byKey) {
    const primary = entries.flatMap((entry) =>
      entry.kind === "local" && entry.provider.primary ? [entry.provider] : [],
    );
    if (primary.length <= 1) {
      continue;
    }
    diagnostics.push(
      diagnostic({
        code: "MULTIPLE_PRIMARY_BEANS",
        message: `Multiple Primary Beans provide ${symbolKey}.`,
        related: primary
          .toSorted((left, right) => compareUtf16CodeUnits(left.id, right.id))
          .map(providerIdentityRelated),
        help: "Keep at most one Primary provider for each interface.",
      }),
    );
  }
}

// 一条待解析边的需求上下文：应用侧边带注入点 span；starter 边继承把它拉进图的那条链
// （MISSING_BEAN 的双侧定位与需求链都从这里来，ADR 0004 决策 13）。
// 可选字段写成 `?: T | undefined`（#367）：这里的「没有位置」「没有消费方」与「字段不在对象
// 上」是同一件事，两种写法都从调用方自然产生，收窄成 `?: T` 只会逼每个构造点写条件展开。
interface DemandContext {
  readonly span?: SourceSpan | undefined;
  readonly chain: readonly string[];
  readonly consumer?: StarterBeanModel | undefined;
}

function demandRelated(demand: DemandContext): readonly DiagnosticRelatedInformation[] {
  const related: DiagnosticRelatedInformation[] = demand.chain.map((id) => ({
    message: `required through ${id}`,
  }));
  if (demand.consumer !== undefined) {
    related.push({ message: `declared by ${demand.consumer.sourceText}` });
  }
  return related;
}

interface ResolutionState {
  readonly candidates: CandidateIndex;
  // logger 依赖重定向表（RFC 0011 L2，#242）：`${consumerId}#${parameterIndex}` → logger bean id。
  readonly loggerRedirects: ReadonlyMap<string, string>;
  // 级别快照 bean 的 id（RFC 0011 L5，#249）；图里没有日志时缺席。
  readonly loggerLevelsBeanId?: string;
  readonly qualifierIndex: ReadonlyMap<string, ProviderModel>;
  readonly drafts: readonly ProviderDraft[];
  readonly linkage: StarterLinkage;
  readonly diagnostics: CompilerDiagnostic[];
  readonly materialized: Map<string, MaterializedStarter>;
  readonly queue: MaterializedStarter[];
  // 被实际绑定的外部契约（#253）：契约 key → 绑定记录。只记绑定成功的边——只装不绑没有
  // 行为风险，dangling 一侧由 MISSING_BEAN + otherCopyRelated 负责。
  readonly boundContracts: Map<string, ContractBinding[]>;
}

interface ContractBinding {
  readonly providerId: string;
  readonly packageName: string;
  readonly copyRoot: string;
  readonly contractName: string;
  readonly span?: SourceSpan;
}

function recordContractBinding(
  state: ResolutionState,
  symbol: LinkedSymbol,
  providerId: string,
  span: SourceSpan | undefined,
): void {
  const external = symbol.external;
  if (external === undefined) {
    return;
  }
  const bindings = state.boundContracts.get(symbol.key) ?? [];
  bindings.push({
    providerId,
    packageName: external.packageName,
    copyRoot: external.packageRoot,
    contractName: symbol.name,
    ...(span === undefined ? {} : { span }),
  });
  state.boundContracts.set(symbol.key, bindings);
}

interface MaterializedStarter {
  readonly draft: ProviderDraft;
  readonly bean: StarterBeanModel;
  readonly demand: DemandContext;
}

function materializeStarter(
  state: ResolutionState,
  bean: StarterBeanModel,
  demand: DemandContext,
): ProviderModel {
  const existing = state.materialized.get(bean.id);
  if (existing !== undefined) {
    return existing.draft.provider;
  }
  const provider: ProviderModel = {
    kind: "class",
    id: bean.id,
    origin: {
      kind: "starter",
      origin: bean.origin,
      runtimeExport: bean.runtimeExport,
      sourceText: bean.sourceText,
    },
    exportName: bean.runtimeExport.export,
    declarationSource: bean.metaSource,
    provides: bean.provides,
    // starter meta v1 没有 scope 面：库模式编译拒绝 @RequestScoped，meta bean 恒为 singleton。
    scope: "singleton",
    primary: false,
    // 物化 starter 恒为 false（#343）：provider 上的 fallback 记的是「源码声明带没带
    // @Fallback()」，而 starter 是从 meta 物化来的、没有源码可读。它的让位资格在
    // StarterBeanModel.defaultBean 上，物化之前 selectStarterCandidate 就已经用掉了。
    fallback: false,
    // 从 meta 物化出来的 starter provider：eager 就是它 meta 里的 role（#369）。它已经进图了，
    // 这里带着只是为了让 provider 表逐字段忠实于 meta。
    eager: bean.root,
    qualifiers: [],
    dependencies: [],
    startHook: bean.lifecycle.start,
    closeHook: bean.lifecycle.close,
  };
  const entry: MaterializedStarter = {
    draft: { provider, pendingDependencies: [] },
    bean,
    demand,
  };
  state.materialized.set(bean.id, entry);
  state.queue.push(entry);
  return provider;
}

function otherCopyRelated(
  state: ResolutionState,
  symbol: LinkedSymbol,
): readonly DiagnosticRelatedInformation[] {
  const coordinate = symbol.external?.coordinate;
  if (coordinate === undefined) {
    return [];
  }
  return (state.candidates.byCoordinate.get(coordinate) ?? [])
    .filter((entry) => entry.key !== symbol.key)
    .map((entry) => ({
      message: `${coordinate} is provided by ${entry.origin} through a different installed copy of the package`,
    }));
}

function missingBeanHelp(
  demand: DemandContext,
  injectableMessage: boolean,
  symbol: LinkedSymbol,
): string {
  // 注入 Logger 却没装任何日志绑定的形状（RFC 0011 L3 勘误，#242）：这条 MISSING_BEAN 的
  // 修法不是「写一个 LoggerFactory」，而是注册 starter——按 isLoggingContract 同款判据特判。
  if (isLoggerFactoryContract(symbol)) {
    return "Register the logging starter from @reforce/logging in defineApplication's starters (or a binding starter such as @reforce/logging-pino).";
  }
  if (demand.consumer !== undefined) {
    return "Provide the starter's open dependency with a local provider or another registered starter.";
  }
  return injectableMessage
    ? "Mark the concrete class Injectable or register a starter that provides it."
    : "Provide it with a local Injectable or defineBean provider, or register a starter that provides it.";
}

function reportMissing(
  state: ResolutionState,
  symbol: LinkedSymbol,
  demand: DemandContext,
  injectableMessage: boolean,
): void {
  state.diagnostics.push(
    diagnostic({
      code: "MISSING_BEAN",
      message: injectableMessage
        ? `No Injectable Bean provides ${symbol.name}.`
        : `No Bean provides ${symbol.name}.`,
      sourceSpan: demand.span,
      related: [...demandRelated(demand), ...otherCopyRelated(state, symbol)],
      help: missingBeanHelp(demand, injectableMessage, symbol),
    }),
  );
}

function selectStarterCandidate(
  state: ResolutionState,
  symbol: LinkedSymbol,
  beans: readonly StarterBeanModel[],
  demand: DemandContext,
): ProviderModel | undefined {
  // defaultBean 只在同契约存在其他候选时让位（决策 12）：全员 default 时它们仍是候选。
  const preferred = beans.filter((bean) => !bean.defaultBean);
  const pool = preferred.length > 0 ? preferred : beans;
  const single = pool.length === 1 ? pool[0] : undefined;
  if (single !== undefined) {
    return materializeStarter(state, single, demand);
  }
  if (pool.length === 0) {
    reportMissing(state, symbol, demand, false);
    return undefined;
  }
  state.diagnostics.push(
    diagnostic({
      code: "AMBIGUOUS_BEAN",
      message: `Multiple Beans provide ${symbol.name}.`,
      sourceSpan: demand.span,
      related: [
        ...pool
          .toSorted((left, right) => compareUtf16CodeUnits(left.id, right.id))
          .map((bean) => ({ message: `${bean.id} (${bean.origin})` })),
        ...demandRelated(demand),
      ],
      help: "Provide the contract locally to override the starters, or register only one providing starter.",
    }),
  );
  return undefined;
}

// 角色 bean 不可被解析（bean-roles.ts）：它由框架构造与调度，注入它拿到的是一个游离于
// 调用链之外的实例。候选表照旧收录它——selectProvider 的"自身 class 符号直取"特例走 ownId
// 直接命中，抽掉入表只会把这条诊断退化成误导性的 MISSING_BEAN。
//
// 已知缺口（有意保留）：用户手写 context.get(RoleGuard) 拦不住。运行时 get() 必须保持万能，
// 框架自己就在用它解析角色实例；堵它要新增一遍 .get() 调用点分析，对别名与间接引用还不可靠。
function rejectRoleBeanDependency(
  state: ResolutionState,
  provider: ProviderModel,
  demand: DemandContext,
  span: SourceSpan | undefined,
): boolean {
  if (provider.role === undefined) {
    return false;
  }
  const spec = beanRoleSpecOf(provider.role);
  state.diagnostics.push(
    diagnostic({
      code: "ROLE_BEAN_AS_DEPENDENCY",
      message: `${provider.exportName} plays the ${spec.label} role: the framework resolves and schedules it, so it cannot be injected as a dependency.`,
      sourceSpan: span,
      related: [providerIdentityRelated(provider), ...demandRelated(demand)],
      help: `Extract the shared logic into an @Injectable() service and inject that service into the ${spec.label}.`,
    }),
  );
  return true;
}

function selectProvider(
  state: ResolutionState,
  symbol: LinkedSymbol,
  demand: DemandContext,
): ProviderModel | undefined {
  const selected = selectCandidate(state, symbol, demand);
  if (selected === undefined || rejectRoleBeanDependency(state, selected, demand, demand.span)) {
    return undefined;
  }
  return selected;
}

function selectCandidate(
  state: ResolutionState,
  symbol: LinkedSymbol,
  demand: DemandContext,
): ProviderModel | undefined {
  const available = state.candidates.byKey.get(symbol.key) ?? [];
  const locals = available.flatMap((entry) => (entry.kind === "local" ? [entry.provider] : []));
  const starters = available.flatMap((entry) => (entry.kind === "starter" ? [entry.bean] : []));
  if (symbol.kind === "class") {
    const source = symbol.source;
    const ownId = source === undefined ? undefined : providerId(source.fileId, symbol.name);
    const ownProvider = locals.find(
      (provider) => provider.kind === "class" && provider.id === ownId,
    );
    if (ownProvider !== undefined) {
      return ownProvider;
    }
    if (locals.length === 0 && starters.length === 0) {
      reportMissing(state, symbol, demand, true);
      return undefined;
    }
  }
  const singleLocal = locals.length === 1 ? locals[0] : undefined;
  if (singleLocal !== undefined) {
    return singleLocal;
  }
  if (locals.length === 0) {
    return selectStarterCandidate(state, symbol, starters, demand);
  }
  const primary = locals.filter((provider) => provider.primary);
  const singlePrimary = primary.length === 1 ? primary[0] : undefined;
  if (singlePrimary !== undefined) {
    return singlePrimary;
  }
  if (primary.length === 0) {
    state.diagnostics.push(
      diagnostic({
        code: "AMBIGUOUS_BEAN",
        message: `Multiple Beans provide ${symbol.name}.`,
        sourceSpan: demand.span,
        related: locals.map(providerIdentityRelated),
        help: "Mark one provider Primary or inject a generated qualifier.",
      }),
    );
  }
  return undefined;
}

function qualifiedDependencyProvider(
  state: ResolutionState,
  pending: PendingDependency,
): ProviderModel | undefined {
  const qualifierMember = pending.linkedType.qualifierMember;
  if (qualifierMember === undefined) {
    return undefined;
  }
  const selected = state.qualifierIndex.get(
    qualifierIndexKey(pending.linkedType.symbol.key, qualifierMember),
  );
  if (selected !== undefined) {
    const demand: DemandContext = { span: pending.linkedType.span, chain: [] };
    return rejectRoleBeanDependency(state, selected, demand, pending.linkedType.span)
      ? undefined
      : selected;
  }
  state.diagnostics.push(
    diagnostic({
      code: "UNKNOWN_BEAN_QUALIFIER",
      message: `Unknown qualifier ${pending.linkedType.symbol.name}.${qualifierMember}.`,
      sourceSpan: pending.linkedType.span,
      related: qualifierAvailabilityRelated(state.drafts, pending.linkedType.symbol.key),
      help: "Use one of the generated qualifier members for this interface.",
    }),
  );
  return undefined;
}

// ADR 0005 决策 5.4：config 先于一切 bean 构造，Lazy 包装没有可延迟的东西。
function rejectLazyConfigInjection(
  state: ResolutionState,
  pending: PendingDependency,
  selected: ProviderModel,
): boolean {
  if (selected.kind !== "config" || !pending.linkedType.lazy) {
    return false;
  }
  state.diagnostics.push(
    diagnostic({
      code: "INVALID_CONFIG_INJECTION",
      message: `${pending.linkedType.symbol.name} is a config class and is bound before any Bean constructs, so Lazy injection defers nothing.`,
      sourceSpan: pending.linkedType.span,
      related: [providerIdentityRelated(selected)],
      help: "Inject the config class directly without the Lazy wrapper.",
    }),
  );
  return true;
}

interface CollectionMemberCandidate {
  readonly id: string;
  readonly order?: number;
}

// 集合排序（ADR 0006 W6）：@Order 数值升序在前，无 @Order 的成员排在全部有序成员之后，
// 同序值与无序成员一律按 beanId 决定性决胜。
function compareCollectionMembers(
  left: CollectionMemberCandidate,
  right: CollectionMemberCandidate,
): number {
  if (left.order !== right.order) {
    if (left.order === undefined) {
      return 1;
    }
    if (right.order === undefined) {
      return -1;
    }
    return left.order - right.order;
  }
  return compareUtf16CodeUnits(left.id, right.id);
}

// 集合成员资格 = 图里所有提供该契约的候选（决策 11 的可达性语义照旧：被集合选中的 starter bean
// 由此物化入图）。defaultBean 沿用单边的让位规则（决策 12）：存在任何其他候选即退出，全员
// default 时全部入集合。空集合合法——零成员注入空数组，不是 MISSING_BEAN。
//
// 角色 bean 静默排除（bean-roles.ts）：中间件只要实现了某个被集合注入的接口就会混进集合，
// 还丢掉编译期压平好的链顺序。这里不报错——空集合本就合法，"少一个成员"没有可点名的错误点。
function collectionMemberIds(
  state: ResolutionState,
  symbol: LinkedSymbol,
  demand: DemandContext,
): readonly string[] {
  const available = state.candidates.byKey.get(symbol.key) ?? [];
  const locals = available.flatMap((entry) =>
    entry.kind === "local" && entry.provider.role === undefined ? [entry.provider] : [],
  );
  const starters = available.flatMap((entry) => (entry.kind === "starter" ? [entry.bean] : []));
  const preferred = starters.filter((bean) => !bean.defaultBean);
  const pool = locals.length > 0 || preferred.length > 0 ? preferred : starters;
  const members: CollectionMemberCandidate[] = [
    ...locals.map((provider) => ({ id: provider.id, order: provider.order })),
    ...pool.map((bean) => ({ id: materializeStarter(state, bean, demand).id })),
  ];
  const memberIds = members.toSorted(compareCollectionMembers).map((member) => member.id);
  for (const memberId of memberIds) {
    recordContractBinding(state, symbol, memberId, demand.span);
  }
  return memberIds;
}

function collectionDependencyFor(
  state: ResolutionState,
  pending: PendingDependency,
  demand: DemandContext,
): CollectionDependencyModel {
  return {
    parameterIndex: pending.index,
    members: collectionMemberIds(state, pending.linkedType.symbol, demand).map((targetId) => ({
      targetId,
      mode: "eager",
    })),
    source: sourceReference(pending.sourceSpan),
    contract: pending.linkedType.symbol,
  };
}

function singleDependencyFor(
  state: ResolutionState,
  pending: PendingDependency,
  demand: DemandContext,
): SingleDependencyModel | undefined {
  const selected =
    pending.linkedType.qualifierMember === undefined
      ? selectProvider(state, pending.linkedType.symbol, demand)
      : qualifiedDependencyProvider(state, pending);
  if (selected === undefined || rejectLazyConfigInjection(state, pending, selected)) {
    return undefined;
  }
  recordContractBinding(state, pending.linkedType.symbol, selected.id, pending.linkedType.span);
  return {
    parameterIndex: pending.index,
    targetId: selected.id,
    mode: singleDependencyMode(pending),
    source: sourceReference(pending.sourceSpan),
    contract: pending.linkedType.symbol,
  };
}

function singleDependencyMode(pending: PendingDependency): "eager" | "explicit-lazy" | "current" {
  if (pending.linkedType.current) {
    return "current";
  }
  return pending.linkedType.lazy ? "explicit-lazy" : "eager";
}

// 全设计唯一的解析特例（RFC 0011 L2，#242），所以它有名字。合成的 logger bean 刻意不进候选池
// （provides 为空），消费者那条边由编译器点名指过去——走 selectProvider 的话，N 个 logger 同时
// 提供 Logger 契约，每条 Logger 边都会是 AMBIGUOUS_BEAN。
function redirectedLoggerDependency(
  state: ResolutionState,
  consumerId: string,
  pending: PendingDependency,
): SingleDependencyModel | undefined {
  const targetId = state.loggerRedirects.get(redirectKey(consumerId, pending.index));
  if (targetId === undefined) {
    return undefined;
  }
  return {
    parameterIndex: pending.index,
    targetId,
    // 模式必须照抄 pending，不能恒 eager：`Lazy<Logger>` 写成 eager 时 tsc 也拦不住——
    // `resolve<T>(i): T` 的 T 由构造参数的上下文类型推断成 Lazy<Logger>，编译期一片安静，
    // 运行期字段拿到的却是 BoundLogger 实例，调 .get() 当场 TypeError。
    mode: singleDependencyMode(pending),
    source: sourceReference(pending.sourceSpan),
    contract: pending.linkedType.symbol,
  };
}

// 同一条解析特例的第二个成员（RFC 0011 L5，#249）：级别快照 bean 同样 provides 为空，边由
// 符号身份点名。与 Logger 的区别是它全图唯一，所以不需要逐消费者的重定向表——两侧（应用里
// 用户自写的 LoggerFactory、starter meta 里 pino 的那条边）认的是同一个契约，而它们解析出的
// key 锚点不同，按 key 匹配会漏掉其中一侧。
function loggerLevelsTargetFor(state: ResolutionState, symbol: LinkedSymbol): string | undefined {
  return isLoggerLevelsContract(symbol) ? state.loggerLevelsBeanId : undefined;
}

function resolveLocalDraftDependencies(state: ResolutionState): void {
  for (const draft of state.drafts) {
    for (const pending of draft.pendingDependencies) {
      const demand: DemandContext = {
        span: pending.linkedType.span,
        chain: [draft.provider.id],
      };
      if (pending.collection === true) {
        draft.provider.dependencies.push(collectionDependencyFor(state, pending, demand));
        continue;
      }
      const redirected = redirectedLoggerDependency(state, draft.provider.id, pending);
      if (redirected !== undefined) {
        draft.provider.dependencies.push(redirected);
        continue;
      }
      const levelsTarget = loggerLevelsTargetFor(state, pending.linkedType.symbol);
      if (levelsTarget !== undefined) {
        draft.provider.dependencies.push({
          parameterIndex: pending.index,
          targetId: levelsTarget,
          mode: singleDependencyMode(pending),
          source: sourceReference(pending.sourceSpan),
          contract: pending.linkedType.symbol,
        });
        continue;
      }
      const dependency = singleDependencyFor(state, pending, demand);
      if (dependency !== undefined) {
        draft.provider.dependencies.push(dependency);
      }
    }
  }
}

function resolveStarterQueue(state: ResolutionState): void {
  // 队列在循环中增长（选中新的 starter bean 即物化入队）；FIFO 顺序由确定的种子顺序与
  // 确定的选择结果决定，输出经全局排序，不依赖这里的遍历次序。
  for (let index = 0; index < state.queue.length; index += 1) {
    const entry = state.queue[index];
    if (entry === undefined) {
      continue;
    }
    for (const edge of entry.bean.dependencies) {
      const demand: DemandContext = {
        span: entry.demand.span,
        chain: [...entry.demand.chain, entry.bean.id],
        consumer: entry.bean,
      };
      const symbol = state.linkage.resolveContract(entry.bean, edge.contract);
      if (symbol === undefined) {
        state.diagnostics.push(
          diagnostic({
            code: "MISSING_BEAN",
            message: `No Bean provides ${edge.contract}.`,
            sourceSpan: demand.span,
            related: demandRelated(demand),
            help: "Provide the starter's open dependency with a local provider or another registered starter.",
          }),
        );
        continue;
      }
      if (edge.collection) {
        // 直接复用 collectionMemberIds（#228）：成员资格、defaultBean 让位、@Order 排序、角色 bean
        // 静默排除全在里面）。不能走 collectionDependencyFor——它吃的是 local 形态的
        // PendingDependency，而 starter 边只有 {index, contract}。
        entry.draft.provider.dependencies.push({
          parameterIndex: edge.index,
          members: collectionMemberIds(state, symbol, demand).map((targetId) => ({
            targetId,
            mode: "eager",
          })),
          source: entry.bean.metaSource,
          contract: symbol,
        });
        continue;
      }
      const targetId =
        loggerLevelsTargetFor(state, symbol) ?? selectProvider(state, symbol, demand)?.id;
      if (targetId === undefined) {
        continue;
      }
      recordContractBinding(state, symbol, targetId, demand.span);
      entry.draft.provider.dependencies.push({
        parameterIndex: edge.index,
        targetId,
        mode: "eager",
        source: entry.bean.metaSource,
        contract: symbol,
      });
    }
  }
}

// 解析完成后的撕裂扫描（#253 设计定案）：coordinate（包名+包内路径+导出名，不含物理路径）
// 是跨拷贝归一键——同 coordinate 存在 ≥2 个被绑定的 key，说明多个消费者各自绑到了同名包
// 不同物理拷贝的实现。这不构成 AMBIGUOUS_BEAN（key 不同、各解析各的），症状（方法找不到、
// 行为不一致）发生在运行期且远离原因，所以主动报出来；anchor 取最早的带 span 绑定点，
// 让 reforce-ignore 抑制注释有处可放。
function reportSplitContractBindings(state: ResolutionState): void {
  for (const entries of state.candidates.byCoordinate.values()) {
    const boundKeys = [...new Set(entries.map((entry) => entry.key))]
      .filter((key) => state.boundContracts.has(key))
      .toSorted(compareUtf16CodeUnits);
    if (boundKeys.length < 2) {
      continue;
    }
    const bindings = boundKeys.flatMap((key) => state.boundContracts.get(key) ?? []);
    const first = bindings[0];
    if (first === undefined) {
      continue;
    }
    const anchor = bindings
      .flatMap((binding) => (binding.span === undefined ? [] : [binding.span]))
      .toSorted((left, right) => {
        const file = compareUtf16CodeUnits(left.fileId, right.fileId);
        return file === 0 ? left.start.offset - right.start.offset : file;
      })
      .at(0);
    state.diagnostics.push(
      diagnostic({
        code: "SPLIT_CONTRACT_BINDING",
        severity: "warning",
        message: `${first.contractName} is bound through ${boundKeys.length} different installed copies of ${first.packageName}.`,
        ...(anchor === undefined ? {} : { sourceSpan: anchor }),
        related: bindings.map((binding) => ({
          message: `bound to ${binding.providerId} (copy at ${binding.copyRoot})`,
          ...(binding.span === undefined ? {} : { sourceSpan: binding.span }),
        })),
        help: `Run "reforce explain ${first.contractName}" to see each copy's introduction chain, or align versions so one copy serves every consumer.`,
      }),
    );
  }
}

export function resolveProviders(
  drafts: readonly ProviderDraft[],
  linkage: StarterLinkage,
  diagnostics: CompilerDiagnostic[],
  // 生成代码的显式需求（ADR 0006 W2 的 #153 接线）：web 引擎 bean 由生成的 bootstrap 经
  // 容器解析，需求方不在 DI 图内，因此在这里显式入根，与 role:"root" 同一物化通道。
  demandedBeanIds: ReadonlySet<string> = new Set(),
  loggerRedirects: ReadonlyMap<string, string> = new Map(),
  loggerLevelsBeanId?: string,
): readonly ProviderDraft[] {
  const candidates = indexCandidates(drafts, linkage.beans);
  const qualifierIndex = indexQualifiers(drafts, diagnostics);
  validatePrimaryCandidates(candidates, diagnostics);
  const state: ResolutionState = {
    candidates,
    loggerRedirects,
    ...(loggerLevelsBeanId === undefined ? {} : { loggerLevelsBeanId }),
    qualifierIndex,
    drafts,
    linkage,
    diagnostics,
    materialized: new Map(),
    queue: [],
    boundContracts: new Map(),
  };
  // 可达性即成员资格（决策 11）：应用本地 bean 都是根，role:"root" 的 starter bean 显式入根；
  // 其余 starter bean 只有被某条已解析边选中才物化——不入名单的连坏引用都不报错。
  for (const bean of [...linkage.beans].sort((left, right) =>
    compareUtf16CodeUnits(left.id, right.id),
  )) {
    if (bean.root || demandedBeanIds.has(bean.id)) {
      materializeStarter(state, bean, { chain: [] });
    }
  }
  resolveLocalDraftDependencies(state);
  resolveStarterQueue(state);
  const starterDrafts = [...state.materialized.values()].map((entry) => entry.draft);
  validateBeanIdentities([...drafts, ...starterDrafts], diagnostics);
  reportSplitContractBindings(state);
  return starterDrafts;
}
