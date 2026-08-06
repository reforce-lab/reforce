// 配置来源输出（RFC 0011 C4，#250）。provenance（键 → 层标签）本来就有，此前只喂给报错的
// layer 字段，启动期一个字都不打——「这个值到底是哪一层给的」得靠人去比对四个文件。
//
// **脱敏铁律**：只出键名与层，永不出值（ADR 0005 决策 6.2）。这条铁律做成了签名——下面这个
// 函数根本收不到 values map，而不是靠每个改这段代码的人自觉。
export interface ProvenanceRecord {
  readonly level: "info" | "debug";
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

// 层的排序对齐 loadEnvironmentSnapshot 的合并顺序（后者覆盖前者），这样读者看到的顺序就是
// 优先级顺序。`.env.<profile>` 是动态标签，排在两个固定文件层之后、process-env 之前。
const layerRanks = new Map([
  [".env", 0],
  [".env.local", 1],
  ["process-env", 3],
]);
const profileLayerRank = 2;

function rankOf(layer: string): number {
  return layerRanks.get(layer) ?? profileLayerRank;
}

function countByLayer(
  provenance: ReadonlyMap<string, string>,
  keys: readonly string[],
): readonly { readonly layer: string; readonly keyCount: number }[] {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const layer = provenance.get(key);
    if (layer === undefined) {
      continue;
    }
    counts.set(layer, (counts.get(layer) ?? 0) + 1);
  }
  return [...counts]
    .map(([layer, keyCount]) => ({ layer, keyCount }))
    .toSorted((left, right) => {
      const rank = rankOf(left.layer) - rankOf(right.layer);
      // 同 rank（两个 profile 标签不可能同时出现，但排序得是全序）按标签定序，输出才逐字节稳定。
      return rank === 0 ? (left.layer < right.layer ? -1 : 1) : rank;
    });
}

export function configProvenanceRecords(input: {
  readonly provenance: ReadonlyMap<string, string>;
  /** 只报本应用真的绑了的那些前缀，环境里其余几百个变量与配置无关。 */
  readonly keyPrefixes: readonly string[];
  readonly detail: boolean;
}): readonly ProvenanceRecord[] {
  const keys = [...input.provenance.keys()]
    .filter((key) => input.keyPrefixes.some((prefix) => key.startsWith(prefix)))
    .sort();
  const summary: ProvenanceRecord = {
    level: "info",
    message: "config keys resolved from environment layers",
    fields: {
      keyCount: keys.length,
      layers: countByLayer(input.provenance, keys),
      // 出口是调级别（不变量 4）：逐键明细是 debug 档的内容，要它时才付钱。
      expandWith: "LOGGING_LEVEL_REFORCE_CONFIG=debug",
    },
  };
  // 不变量 8：早返回在逐键结构构造**之前**，不是构造完再丢。
  if (!input.detail) {
    return [summary];
  }
  return [
    summary,
    {
      level: "debug",
      message: "config key provenance",
      // 一条记录带一个数组，而不是 N 条记录：引导缓冲是定容的，逐键刷屏会把它撑爆，
      // 挤掉缓冲本来就是为了保住的那几条绑定告警。
      fields: {
        sources: keys.map((key) => ({ key, layer: input.provenance.get(key) })),
      },
    },
  ];
}
