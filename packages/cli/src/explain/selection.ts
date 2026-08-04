import type { InstalledStarter } from "@/explain/starter-metas";
import type {
  GeneratedManifest,
  ManifestBean,
  ManifestSymbolReference,
} from "@/project/generated-manifest";

// 选择链的再推导（Issue #148）：manifest 只记录最终胜出者，这里按 ADR 0004 决策 12 的两条
// 确定性规则把「为何胜出、谁让位」还原出来——本地 provider 恒胜 starter；defaultBean 在存在
// 其他候选时退出。规则是链接器语义的展示层复述，不做任何选择本身；manifest 与 meta 若在构建
// 后漂移，输出如实反映当前磁盘状态。

export type StandingAsideReason =
  | "local-provider-wins"
  | "default-bean-stands-aside"
  | "not-selected";

export interface StandingAsideBean {
  readonly beanId: string;
  readonly origin: string;
  readonly reason: StandingAsideReason;
}

export interface ContractExplanation {
  readonly contract: ManifestSymbolReference;
  /** manifest 中提供该契约的 bean（含被解释的 bean 自身），按 id 排序。 */
  readonly providers: readonly ManifestBean[];
  /** 注入决胜者：唯一 provider，或多 provider 中唯一的 primary；其余组合走 qualifier。 */
  readonly injectionWinner: ManifestBean | undefined;
  readonly standingAside: readonly StandingAsideBean[];
}

function symbolIdentity(symbol: ManifestSymbolReference): string {
  return `${symbol.moduleSpecifier}\0${symbol.exportName}`;
}

// meta 契约坐标（ADR 0004 决策 7）：`包名#导出名`，无 meta 契约包退化为 `包名:包内路径#导出名`。
function coordinateParts(
  coordinate: string,
): { readonly packageName: string; readonly exportName: string } | undefined {
  const separator = coordinate.lastIndexOf("#");
  if (separator <= 0 || separator === coordinate.length - 1) {
    return undefined;
  }
  const locator = coordinate.slice(0, separator);
  const fileSeparator = locator.indexOf(":");
  return {
    packageName: fileSeparator === -1 ? locator : locator.slice(0, fileSeparator),
    exportName: coordinate.slice(separator + 1),
  };
}

// manifest 外部 symbol 的 moduleSpecifier 已归一为包视角（包名或包名/子路径，见 PR #154），
// 与 meta 坐标按「包名 + 导出名」对齐；包内文件级差异对展示不构成歧义。
function coordinateMatches(coordinate: string, symbol: ManifestSymbolReference): boolean {
  const parts = coordinateParts(coordinate);
  if (parts === undefined || parts.exportName !== symbol.exportName) {
    return false;
  }
  return (
    symbol.moduleSpecifier === parts.packageName ||
    symbol.moduleSpecifier.startsWith(`${parts.packageName}/`)
  );
}

function injectionWinner(providers: readonly ManifestBean[]): ManifestBean | undefined {
  if (providers.length === 1) {
    return providers[0];
  }
  const primaries = providers.filter((provider) => provider.primary);
  return primaries.length === 1 ? primaries[0] : undefined;
}

function standingAsideReason(
  providers: readonly ManifestBean[],
  defaultBean: boolean,
): StandingAsideReason {
  if (providers.some((provider) => provider.origin === "application")) {
    return "local-provider-wins";
  }
  if (defaultBean) {
    return "default-bean-stands-aside";
  }
  return "not-selected";
}

export function explainContracts(
  manifest: GeneratedManifest,
  starters: readonly InstalledStarter[],
  target: ManifestBean,
): readonly ContractExplanation[] {
  return target.provides.map((contract) => {
    const identity = symbolIdentity(contract);
    const providers = manifest.beans
      .filter((bean) => bean.provides.some((provided) => symbolIdentity(provided) === identity))
      .sort((left, right) => left.id.localeCompare(right.id));
    const materialized = new Set(providers.map((bean) => `${bean.id}\0${bean.origin}`));
    const standingAside = starters.flatMap((starter) =>
      starter.beans.flatMap((bean): StandingAsideBean[] => {
        const origin = `${starter.packageName}@${starter.version}`;
        if (materialized.has(`${bean.id}\0${origin}`)) {
          return [];
        }
        if (!bean.provides.some((coordinate) => coordinateMatches(coordinate, contract))) {
          return [];
        }
        return [
          { beanId: bean.id, origin, reason: standingAsideReason(providers, bean.defaultBean) },
        ];
      }),
    );
    return { contract, providers, injectionWinner: injectionWinner(providers), standingAside };
  });
}
