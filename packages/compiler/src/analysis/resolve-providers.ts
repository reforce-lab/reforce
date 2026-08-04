import { compareUtf16CodeUnits } from "@reforce/primitives";
import { name as isIdentifierName } from "estree-util-is-identifier-name";
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
interface DemandContext {
  readonly span?: SourceSpan;
  readonly chain: readonly string[];
  readonly consumer?: StarterBeanModel;
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
  readonly qualifierIndex: ReadonlyMap<string, ProviderModel>;
  readonly drafts: readonly ProviderDraft[];
  readonly linkage: StarterLinkage;
  readonly diagnostics: CompilerDiagnostic[];
  readonly materialized: Map<string, MaterializedStarter>;
  readonly queue: MaterializedStarter[];
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

function missingBeanHelp(demand: DemandContext, injectableMessage: boolean): string {
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
      help: missingBeanHelp(demand, injectableMessage),
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

function selectProvider(
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
    return selected;
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
function collectionMemberIds(
  state: ResolutionState,
  symbol: LinkedSymbol,
  demand: DemandContext,
): readonly string[] {
  const available = state.candidates.byKey.get(symbol.key) ?? [];
  const locals = available.flatMap((entry) => (entry.kind === "local" ? [entry.provider] : []));
  const starters = available.flatMap((entry) => (entry.kind === "starter" ? [entry.bean] : []));
  const preferred = starters.filter((bean) => !bean.defaultBean);
  const pool = locals.length > 0 || preferred.length > 0 ? preferred : starters;
  const members: CollectionMemberCandidate[] = [
    ...locals.map((provider) => ({ id: provider.id, order: provider.order })),
    ...pool.map((bean) => ({ id: materializeStarter(state, bean, demand).id })),
  ];
  return members.toSorted(compareCollectionMembers).map((member) => member.id);
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
      const selected = selectProvider(state, symbol, demand);
      if (selected === undefined) {
        continue;
      }
      entry.draft.provider.dependencies.push({
        parameterIndex: edge.index,
        targetId: selected.id,
        mode: "eager",
        source: entry.bean.metaSource,
        contract: symbol,
      });
    }
  }
}

export function resolveProviders(
  drafts: readonly ProviderDraft[],
  linkage: StarterLinkage,
  diagnostics: CompilerDiagnostic[],
): readonly ProviderDraft[] {
  const candidates = indexCandidates(drafts, linkage.beans);
  const qualifierIndex = indexQualifiers(drafts, diagnostics);
  validatePrimaryCandidates(candidates, diagnostics);
  const state: ResolutionState = {
    candidates,
    qualifierIndex,
    drafts,
    linkage,
    diagnostics,
    materialized: new Map(),
    queue: [],
  };
  // 可达性即成员资格（决策 11）：应用本地 bean 都是根，role:"root" 的 starter bean 显式入根；
  // 其余 starter bean 只有被某条已解析边选中才物化——不入名单的连坏引用都不报错。
  for (const bean of [...linkage.beans].sort((left, right) =>
    compareUtf16CodeUnits(left.id, right.id),
  )) {
    if (bean.root) {
      materializeStarter(state, bean, { chain: [] });
    }
  }
  resolveLocalDraftDependencies(state);
  resolveStarterQueue(state);
  const starterDrafts = [...state.materialized.values()].map((entry) => entry.draft);
  validateBeanIdentities([...drafts, ...starterDrafts], diagnostics);
  return starterDrafts;
}
