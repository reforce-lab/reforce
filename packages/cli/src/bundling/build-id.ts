type DevBuildAssetRole = "entry" | "chunk" | "source-map" | "hot-update";

export interface DevBuildAsset {
  readonly path: string;
  readonly role: DevBuildAssetRole;
}

export function createDevBuildId(statsHash: string | undefined): string {
  // rspack 每次 seal 都产出非空 compilation.hash，拿不到 hash 只可能是这次构建根本没走到产出。
  // 这里不再退回自己算的字节哈希：那条兜底在真实 watch 路径上永远不可达，却逼着调用方每次重建把整棵
  // dev 产物读进内存再丢掉（Issue #111）。宁可报错，也不拿编出来的 id 冒充一次健康构建。
  if (!statsHash?.trim()) {
    throw new Error("Development build did not produce an Rspack compilation hash.");
  }
  return `rspack:${statsHash}`;
}
