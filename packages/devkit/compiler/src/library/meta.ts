import { readFile } from "node:fs/promises";
import { compareUtf16CodeUnits } from "@reforce/primitives";
import {
  parseContractCoordinate,
  parseStarterMeta,
  type StarterMeta,
  starterMetaSubpath,
} from "@reforce/starter-meta";
import stableStringify from "json-stable-stringify";
import type { ProviderDraft, SourceReferenceModel } from "@/analysis/model";
import type { CompilerDiagnostic, LibraryGeneratedFile } from "@/api";
import { diagnostic, hasErrorDiagnostic } from "@/diagnostics";
import type { LibrarySurface, LibrarySurfaceSymbol } from "@/library/dist-surface";
import { subpathSpecifier } from "@/linking/external-modules";
import type { ExternalSymbolAttribution, LinkedSymbol } from "@/linking/model";
import type { SourceSpan } from "@/parser/source-location";

// meta 发射（ADR 0004 决策 1/2/6/15，#120/#147）：schema 由应用侧唯一准入
// linking/starter-meta.ts 钉死（#145），本文件只负责按它的语义产出字节，出口处用
// parseStarterMeta 对自产字节做回读自检——发不出通不过消费侧闸门的 meta。
// 坐标语义：本包符号按 dist 面锚点归一为 `包名#导出名`；外部契约保持文件身份，除非该包自身
// 发布了 reforce-meta——命中其户口表即归一为 meta 坐标并记入 starterDeps（决策 6 的传递语义
// 要求：meta 坐标只能指向会进应用注册表的包）。同名包的另一份物理拷贝不归一（决策 10）。

interface LibraryMetaInputs {
  readonly packageName: string;
  readonly projectRoot: string;
  readonly drafts: readonly ProviderDraft[];
  readonly surface: LibrarySurface;
  readonly diagnostics: CompilerDiagnostic[];
}

interface MetaDependencyDraft {
  readonly contract: string;
  open: boolean;
  // 单边不写这个键：省略即 false，已发布的 meta 字节因此不变（schema 侧同为可选键）。
  readonly collection?: true;
}

interface MetaBeanDraft {
  readonly id: string;
  readonly runtimeExport: { readonly module: string; readonly export: string };
  readonly provides: readonly string[];
  readonly dependencies: readonly MetaDependencyDraft[];
  readonly defaultBean?: true;
  readonly lifecycle?: { readonly start?: "onContextStart"; readonly close?: "onContextClose" };
  readonly source: SourceReferenceModel;
}

function unsupportedEdgeKind(pending: ProviderDraft["pendingDependencies"][number]): string {
  if (pending.linkedType.lazy) {
    return "a Lazy dependency";
  }
  return pending.linkedType.current ? "a Current dependency" : "a qualified dependency";
}

function providerSpan(draft: ProviderDraft): SourceSpan | undefined {
  const origin = draft.provider.origin;
  if (origin.kind !== "application") {
    return undefined;
  }
  return {
    fileId: origin.source.fileId,
    start: draft.provider.declarationSource.start,
    end: draft.provider.declarationSource.end,
  };
}

// requires 只登记「读者忽略它就会错配」的能力（#369）：collection 缺席等于单边，旧编译器读到
// 会把集合边静默注成单边。真的用到了才写——没有集合边的 starter 不该因此对读者提出要求，
// 那只会把自己的兼容下限白白抬高。
function requiredCapabilities(beans: readonly MetaBeanDraft[]): {
  readonly requires?: readonly string[];
} {
  const usesCollection = beans.some((bean) =>
    bean.dependencies.some((dependency) => dependency.collection === true),
  );
  return usesCollection ? { requires: ["collection"] } : {};
}

// 自产回读失败是编译器 bug，不是用户错误——所以抛异常而不是发诊断，而这里只负责把三种失败
// 状态翻成一句人话。
function roundTripFailureReason(
  result: Exclude<ReturnType<typeof parseStarterMeta>, { readonly status: "success" }>,
): string {
  if (result.status === "invalid") {
    return result.reason;
  }
  if (result.status === "unsupported-capability") {
    return `unsupported capability ${result.required.join(", ")}`;
  }
  return "unsupported schemaVersion";
}

export async function buildLibraryMeta(
  inputs: LibraryMetaInputs,
): Promise<readonly LibraryGeneratedFile[]> {
  const { packageName, projectRoot, drafts, surface, diagnostics } = inputs;
  const starterDeps = new Set<string>();
  const depMetaCache = new Map<string, StarterMeta | undefined>();

  async function dependencyMeta(external: ExternalSymbolAttribution): Promise<
    | {
        readonly packageName: string;
        readonly meta: StarterMeta;
      }
    | undefined
  > {
    if (depMetaCache.has(external.packageRoot)) {
      const cached = depMetaCache.get(external.packageRoot);
      return cached === undefined ? undefined : { packageName: external.packageName, meta: cached };
    }
    const miss = (): undefined => {
      depMetaCache.set(external.packageRoot, undefined);
      return undefined;
    };
    const metaPath = surface.resolveFromDirectory(
      projectRoot,
      `${external.packageName}${starterMetaSubpath.slice(1)}`,
    );
    if (metaPath === undefined) {
      return miss();
    }
    const location = surface.locatePackage(metaPath);
    // 解析到的 meta 必须属于符号绑定到的同一份物理拷贝，否则按决策 10 保持文件身份。
    if (location === undefined || location.rootPath !== external.packageRoot) {
      return miss();
    }
    let parsedBytes: unknown;
    try {
      parsedBytes = JSON.parse(await readFile(metaPath, "utf8"));
    } catch {
      return miss();
    }
    const parsed = parseStarterMeta(parsedBytes, location.packageName);
    if (parsed.status !== "success") {
      return miss();
    }
    depMetaCache.set(external.packageRoot, parsed.meta);
    return { packageName: location.packageName, meta: parsed.meta };
  }

  async function externalCoordinate(external: ExternalSymbolAttribution): Promise<string> {
    const parsed = parseContractCoordinate(external.coordinate);
    if (parsed?.kind !== "file") {
      return external.coordinate;
    }
    const dependency = await dependencyMeta(external);
    const anchor = dependency?.meta.symbols.find(
      (symbol) => symbol.file === parsed.file && symbol.exportName === parsed.exportName,
    );
    if (dependency === undefined || anchor === undefined) {
      return external.coordinate;
    }
    starterDeps.add(dependency.packageName);
    return anchor.id;
  }

  function ownEntryFor(
    symbol: LinkedSymbol,
    span: SourceSpan | undefined,
  ): LibrarySurfaceSymbol | undefined {
    const id = `${packageName}#${symbol.name}`;
    const entry = surface.symbolById(id);
    if (entry === undefined) {
      diagnostics.push(
        diagnostic({
          code: "LIBRARY_EXPORT_MISMATCH",
          message: `${symbol.name} is not reachable from the package's public exports.`,
          sourceSpan: span,
          help: "Export every bean class and contract from an exports subpath, then rebuild dist before reforce lib.",
        }),
      );
      return undefined;
    }
    if (entry.symbol.kind !== symbol.kind || entry.symbol.generic !== symbol.generic) {
      diagnostics.push(
        diagnostic({
          code: "LIBRARY_EXPORT_MISMATCH",
          message: `${symbol.name} has a different shape in the built dist (${entry.symbol.generic ? "generic " : ""}${entry.symbol.kind}) than in the source (${symbol.generic ? "generic " : ""}${symbol.kind}).`,
          sourceSpan: span,
          help: "Rebuild the package dist so the published declarations match the source.",
        }),
      );
      return undefined;
    }
    return entry;
  }

  async function contractCoordinate(
    symbol: LinkedSymbol,
    span: SourceSpan | undefined,
  ): Promise<string | undefined> {
    if (symbol.kind !== "class" && symbol.kind !== "interface") {
      diagnostics.push(
        diagnostic({
          code: "UNSUPPORTED_LIBRARY_DECLARATION",
          message: `${symbol.name} is not a class or interface and cannot be a starter bean contract.`,
          sourceSpan: span,
          help: "Depend on a non-generic class or interface contract.",
        }),
      );
      return undefined;
    }
    if (symbol.external !== undefined) {
      return externalCoordinate(symbol.external);
    }
    return ownEntryFor(symbol, span)?.id;
  }

  function runtimeExportFor(
    entry: LibrarySurfaceSymbol,
  ): { readonly module: string; readonly export: string } | undefined {
    const subpath = entry.subpaths[0];
    if (subpath === undefined) {
      return undefined;
    }
    const atSubpath = entry.locations.filter((location) => location.subpath === subpath);
    const exportedName =
      atSubpath.find((location) => location.exportedName === entry.anchorExportName)
        ?.exportedName ?? atSubpath[0]?.exportedName;
    return exportedName === undefined
      ? undefined
      : { module: subpathSpecifier(packageName, subpath), export: exportedName };
  }

  async function buildBean(draft: ProviderDraft): Promise<MetaBeanDraft | undefined> {
    const provider = draft.provider;
    const span = providerSpan(draft);
    const ownSymbol = provider.provides.find(
      (symbol) =>
        symbol.kind === "class" &&
        symbol.external === undefined &&
        symbol.name === provider.exportName,
    );
    if (ownSymbol === undefined) {
      throw new Error(`Provider ${provider.id} draft is missing its own class symbol`);
    }
    const entry = ownEntryFor(ownSymbol, span);
    return entry === undefined ? undefined : buildBeanFromEntry(draft, entry, span);
  }

  async function providedCoordinates(
    provider: ProviderDraft["provider"],
    span: SourceSpan | undefined,
  ): Promise<readonly string[] | undefined> {
    const provides = new Set<string>();
    for (const provided of provider.provides) {
      const coordinate = await contractCoordinate(provided, span);
      if (coordinate === undefined) {
        return undefined;
      }
      provides.add(coordinate);
    }
    return [...provides].sort(compareUtf16CodeUnits);
  }

  async function dependencyEdges(
    draft: ProviderDraft,
  ): Promise<readonly MetaDependencyDraft[] | undefined> {
    const dependencies: MetaDependencyDraft[] = [];
    const pendings = [...draft.pendingDependencies].sort((left, right) => left.index - right.index);
    for (const pending of pendings) {
      if (
        pending.linkedType.lazy ||
        pending.linkedType.current ||
        pending.linkedType.qualifierMember !== undefined
      ) {
        const edgeKind = unsupportedEdgeKind(pending);
        diagnostics.push(
          diagnostic({
            code: "UNSUPPORTED_LIBRARY_DECLARATION",
            message: `Constructor parameter ${pending.index} on ${draft.provider.exportName} uses ${edgeKind}; starter meta v1 only records plain contract edges.`,
            sourceSpan: pending.sourceSpan,
            help: "Inject the contract directly; qualifiers, Lazy, and Current stay application-side features for now.",
          }),
        );
        return undefined;
      }
      const coordinate = await contractCoordinate(pending.linkedType.symbol, pending.sourceSpan);
      if (coordinate === undefined) {
        return undefined;
      }
      // 集合边是 starter 声明"两座桥"契约（应用级 configurer / 路由级 customizer）的前提（#228）：
      // 单边形态下用户不写实现就是 MISSING_BEAN，而集合的零成员本就合法。
      dependencies.push({
        contract: coordinate,
        open: true,
        ...(pending.collection === true ? { collection: true as const } : {}),
      });
    }
    return dependencies;
  }

  function lifecycleOf(
    provider: ProviderDraft["provider"],
  ): MetaBeanDraft["lifecycle"] | undefined {
    if (provider.kind !== "class" || (!provider.startHook && !provider.closeHook)) {
      return undefined;
    }
    return {
      ...(provider.startHook ? { start: "onContextStart" as const } : {}),
      ...(provider.closeHook ? { close: "onContextClose" as const } : {}),
    };
  }

  async function buildBeanFromEntry(
    draft: ProviderDraft,
    entry: LibrarySurfaceSymbol,
    span: SourceSpan | undefined,
  ): Promise<MetaBeanDraft | undefined> {
    const provider = draft.provider;
    const runtimeExport = runtimeExportFor(entry);
    if (runtimeExport === undefined) {
      return undefined;
    }
    const provides = await providedCoordinates(provider, span);
    const dependencies = provides === undefined ? undefined : await dependencyEdges(draft);
    if (provides === undefined || dependencies === undefined) {
      return undefined;
    }
    const lifecycle = lifecycleOf(provider);
    return {
      id: entry.id,
      runtimeExport,
      provides,
      dependencies: [...dependencies],
      // 缺省即 false，所以只有 true 才写键（与 lifecycle 同法）：读取侧把缺席归一为 false，
      // 多写一个 `defaultBean: false` 只是噪音。role 同理，缺省即 "demand"。
      ...(provider.fallback ? { defaultBean: true as const } : {}),
      ...(provider.eager ? { role: "root" as const } : {}),
      ...(lifecycle === undefined ? {} : { lifecycle }),
      source: provider.declarationSource,
    };
  }

  const beans: MetaBeanDraft[] = [];
  for (const draft of drafts) {
    const bean = await buildBean(draft);
    if (bean !== undefined) {
      beans.push(bean);
    }
  }
  beans.sort((left, right) => compareUtf16CodeUnits(left.id, right.id));

  // open = 该契约是否需要外部供给（应用或其他 starter）。本包 bean 已提供的边闭合，与
  // resolve-providers 的按需拉取语义对齐：闭合边默认在包内成链。
  const ownProvided = new Set(beans.flatMap((bean) => bean.provides));
  for (const bean of beans) {
    for (const dependency of bean.dependencies) {
      dependency.open = !ownProvided.has(dependency.contract);
    }
  }

  // 只有 error 才拦住 meta 发射：warning 说明分析结果完整，只是有话要说（RFC 0011 OM2，#242）。
  if (hasErrorDiagnostic(diagnostics)) {
    return [];
  }

  const meta = {
    schemaVersion: 1,
    ...requiredCapabilities(beans),
    starterDeps: [...starterDeps].sort(compareUtf16CodeUnits),
    symbols: surface.symbols.map((symbol) => ({
      id: symbol.id,
      file: symbol.anchorFile,
      subpaths: symbol.subpaths,
    })),
    beans,
  };
  const metaJson = stableStringify(meta, { space: 2 });
  if (metaJson === undefined) {
    throw new Error("Library meta is not serializable");
  }
  // 自产回读走 strict（#369）：消费侧忽略未知键，而这一侧读者与写者同版本——冒出未知键说明
  // 生成器与 schema 漂了（#343 就是那样漏掉 defaultBean 的），正是这道自检要抓的。
  const roundTrip = parseStarterMeta(JSON.parse(metaJson), packageName, { strict: true });
  if (roundTrip.status !== "success") {
    throw new Error(
      `reforce lib produced meta that fails the consumer schema gate: ${roundTripFailureReason(roundTrip)}`,
    );
  }
  return [{ path: "reforce-meta.json", content: `${metaJson}\n` }];
}
