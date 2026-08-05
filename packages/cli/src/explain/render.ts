import type { ContractExplanation, StandingAsideBean } from "@/explain/selection";
import type { InstalledStarter } from "@/explain/starter-metas";
import { multipleCopyGroups } from "@/explain/starter-metas";
import type { WeavingMetaValue, WeavingMethod } from "@/explain/weaving";
import type {
  GeneratedManifest,
  ManifestBean,
  ManifestSourceReference,
} from "@/project/generated-manifest";
import {
  frameworkOriginId,
  manifestDependencyEdges,
  starterOriginPackageName,
} from "@/project/generated-manifest";

// explain 的输出契约：一行一个事实、无对齐留白、字段用 " · " 分隔——供人读也供脚本 grep。
// origin 的用户可读呈现（M1 遗留账，PR #154）：`application` 展示为 "this application"，
// starter 展示为 `包名@版本 · registered starter`，源位置一律 1-based 行:列。

function position(source: ManifestSourceReference): string {
  return `${source.file}:${source.start.line + 1}:${source.start.character + 1}`;
}

function originDescription(origin: string): string {
  if (origin === "application") {
    return "this application";
  }
  // 框架合成 bean（ADR 0008 AM2，#204 定案 6）：来源串无版本段，与 starter 措辞区分。
  return origin === frameworkOriginId ? `${origin} · framework` : `${origin} · registered starter`;
}

function sourceDescription(bean: ManifestBean): string {
  const location = position(bean.source);
  if (bean.origin === "application") {
    return location;
  }
  // 框架 bean 的 source 指向把它拉进图的第一处 @Transactional 使用（应用路径，#204 定案 6）。
  if (bean.origin === frameworkOriginId) {
    return `${location} (first @Transactional use)`;
  }
  // starter bean 的 source 相对发布包根（ADR 0004 风险 3 的既定处理），标注基准避免误当应用路径。
  return `${location} (package-relative)`;
}

function standingAsideDescription(entry: StandingAsideBean): string {
  const reasons = {
    "local-provider-wins": "a local provider always wins over starter beans",
    "default-bean-stands-aside": "a default bean stands aside once another provider exists",
    "not-selected": "not selected by the linker",
  } as const;
  return `stood aside ${entry.beanId} (${entry.origin}) — ${reasons[entry.reason]}`;
}

function isDefaultBean(starters: readonly InstalledStarter[], bean: ManifestBean): boolean {
  return starters.some(
    (starter) =>
      `${starter.packageName}@${starter.version}` === bean.origin &&
      starter.beans.some((metaBean) => metaBean.id === bean.id && metaBean.defaultBean),
  );
}

function selectionReason(
  explanation: ContractExplanation,
  starters: readonly InstalledStarter[],
): string {
  const { providers, injectionWinner, standingAside } = explanation;
  if (injectionWinner === undefined) {
    return `multiple providers — injection at this contract requires a qualifier`;
  }
  if (providers.length > 1) {
    return `primary among ${providers.length} providers`;
  }
  if (standingAside.some((entry) => entry.reason === "local-provider-wins")) {
    return `local provider wins over ${standingAside.length} starter candidate(s)`;
  }
  if (standingAside.some((entry) => entry.reason === "default-bean-stands-aside")) {
    return `selected while ${standingAside.length} default bean(s) stand aside`;
  }
  if (isDefaultBean(starters, injectionWinner)) {
    return "accepted default provider — no local or competing provider";
  }
  return "only provider";
}

function packageNameOf(moduleSpecifier: string): string | undefined {
  if (moduleSpecifier.startsWith(".")) {
    return undefined;
  }
  const segments = moduleSpecifier.split("/");
  const nameLength = moduleSpecifier.startsWith("@") ? 2 : 1;
  return segments.length >= nameLength ? segments.slice(0, nameLength).join("/") : undefined;
}

// 与被解释 bean 相关的包：自身 origin、其契约的归属包、其依赖目标的 origin。多份物理拷贝
//（决策 10）只在涉及这些包时呈现，避免每次 explain 都罗列全图。
function relevantPackageNames(
  manifest: GeneratedManifest,
  bean: ManifestBean,
): ReadonlySet<string> {
  const names = new Set<string>();
  const registerOrigin = (origin: string) => {
    const packageName = starterOriginPackageName(origin);
    if (origin !== "application" && packageName !== undefined) {
      names.add(packageName);
    }
  };
  registerOrigin(bean.origin);
  for (const provided of bean.provides) {
    const packageName = packageNameOf(provided.moduleSpecifier);
    if (packageName !== undefined) {
      names.add(packageName);
    }
  }
  for (const dependency of bean.dependencies) {
    for (const edge of manifestDependencyEdges(dependency)) {
      const target = manifest.beans.find((candidate) => candidate.id === edge.targetId);
      if (target !== undefined) {
        registerOrigin(target.origin);
      }
    }
  }
  return names;
}

function contractLines(
  explanation: ContractExplanation,
  starters: readonly InstalledStarter[],
): readonly string[] {
  const winner = explanation.injectionWinner;
  const winnerLabel =
    winner === undefined
      ? `${explanation.providers.length} providers`
      : `${winner.id} (${originDescription(winner.origin)})`;
  return [
    `contract ${explanation.contract.displayName}`,
    `  selected ${winnerLabel} — ${selectionReason(explanation, starters)}`,
    ...explanation.standingAside.map((entry) => `  ${standingAsideDescription(entry)}`),
  ];
}

function dependencyTargetDescription(manifest: GeneratedManifest, targetId: string): string {
  const target = manifest.beans.find((candidate) => candidate.id === targetId);
  if (target !== undefined) {
    return originDescription(target.origin);
  }
  // bean 依赖可以指向 config 条目（ADR 0005，#130）；config 恒为应用侧声明。
  if (manifest.configs.some((config) => config.id === targetId)) {
    return "this application · configuration";
  }
  return "unknown";
}

function dependencyLines(manifest: GeneratedManifest, bean: ManifestBean): readonly string[] {
  return bean.dependencies.flatMap((dependency) => {
    if (dependency.mode !== "collection") {
      return [
        `dependency [${dependency.parameterIndex}] -> ${dependency.targetId} · ${dependencyTargetDescription(manifest, dependency.targetId)} · ${dependency.mode}`,
      ];
    }
    // 集合边：成员行的排列即注入顺序（编译期 @Order + beanId 决胜后写死）。
    return [
      `dependency [${dependency.parameterIndex}] -> collection · ${dependency.members.length} member(s)`,
      ...dependency.members.map(
        (member) =>
          `  member ${member.targetId} · ${dependencyTargetDescription(manifest, member.targetId)} · ${member.mode}`,
      ),
    ];
  });
}

// 请求 bean 走第二组计划（ADR 0006 W7，#151）：位置行标注 per request，与 singleton 计划分开呈现。
function constructionLines(manifest: GeneratedManifest, bean: ManifestBean): readonly string[] {
  if (bean.scope === "request") {
    const requestIndex = manifest.plans.requestConstructionOrder.indexOf(bean.id);
    if (requestIndex === -1) {
      return [];
    }
    return [
      `request construction position ${requestIndex + 1} of ${manifest.plans.requestConstructionOrder.length} · constructed once per request`,
    ];
  }
  const constructionIndex = manifest.plans.constructionOrder.indexOf(bean.id);
  if (constructionIndex === -1) {
    return [];
  }
  return [
    `construction position ${constructionIndex + 1} of ${manifest.plans.constructionOrder.length}`,
  ];
}

function copyLines(
  manifest: GeneratedManifest,
  bean: ManifestBean,
  starters: readonly InstalledStarter[],
): readonly string[] {
  const relevant = relevantPackageNames(manifest, bean);
  return [...multipleCopyGroups(starters)]
    .filter(([packageName]) => relevant.has(packageName))
    .flatMap(([packageName, copies]) => [
      `copies ${packageName} — ${copies.length} physical copies installed`,
      ...copies.map((copy) => {
        const via =
          copy.introducedBy === undefined
            ? "reachable from the application root"
            : `introduced by ${copy.introducedBy}`;
        return `  ${copy.version} at ${copy.location} · ${via}`;
      }),
    ]);
}

// @Transactional 行渲染生效语义（#204 定案 7）：织入表存原样字面量，缺省在呈现层补齐——
// 传播缺省 REQUIRED、隔离缺省用数据库默认。其他标记原样渲染字面量。
// Array.isArray 的否定分支收窄不掉 readonly 数组（其谓词是 any[]），改用 Reflect.get 读可选键。
function metaOption(value: WeavingMetaValue, key: string): WeavingMetaValue | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Reflect.get(value, key) as WeavingMetaValue | undefined; // 索引签名成员，值域即声明类型
}

function markerDescription(key: string, value: WeavingMetaValue): string {
  if (key !== "transactional") {
    return value === null ? `marker ${key}` : `marker ${key} · value ${JSON.stringify(value)}`;
  }
  const propagation = metaOption(value, "propagation");
  const isolation = metaOption(value, "isolation");
  return [
    "marker transactional",
    `effective propagation ${typeof propagation === "string" ? propagation : "REQUIRED"}`,
    `effective isolation ${typeof isolation === "string" ? isolation : "database default"}`,
  ].join(" · ");
}

// 织入面（ADR 0008 不变量 2，#204 定案 7）：链序即行序（外→内），每行一个事实回答
// "这个方法被谁包、为什么是这个顺序"；空链方法照渲染（标记是元数据，表里可见即可审）。
function weavingLines(
  manifest: GeneratedManifest,
  wovenMethods: readonly WeavingMethod[],
): readonly string[] {
  return wovenMethods.flatMap((method) => [
    `woven method ${method.method}`,
    ...Object.entries(method.markers).map(([key, value]) => `  ${markerDescription(key, value)}`),
    ...(method.chain.length === 0
      ? ["  chain empty · marked but no interceptor bound"]
      : method.chain.map(
          (entry, index) =>
            `  chain [${index + 1}] ${entry.beanId} · ${dependencyTargetDescription(manifest, entry.beanId)} · phase ${entry.phase} · order ${entry.order} · via ${entry.marker}`,
        )),
  ]);
}

export function renderExplanation(input: {
  readonly manifest: GeneratedManifest;
  readonly bean: ManifestBean;
  readonly starters: readonly InstalledStarter[];
  readonly contracts: readonly ContractExplanation[];
  readonly wovenMethods: readonly WeavingMethod[];
}): readonly string[] {
  const { manifest, bean, starters, contracts, wovenMethods } = input;
  return [
    `bean ${bean.id}`,
    // singleton 是缺省语义，不加噪音；request scope 是读者必须知道的行为差异，单列一行。
    ...(bean.scope === "request" ? ["scope request · one instance per request"] : []),
    `origin ${originDescription(bean.origin)} · declared at ${sourceDescription(bean)}`,
    `runtime import { ${bean.runtimeExport.exportName} } from "${bean.runtimeExport.moduleSpecifier}"`,
    ...contracts.flatMap((explanation) => contractLines(explanation, starters)),
    ...dependencyLines(manifest, bean),
    ...weavingLines(manifest, wovenMethods),
    ...constructionLines(manifest, bean),
    ...copyLines(manifest, bean, starters),
  ];
}
