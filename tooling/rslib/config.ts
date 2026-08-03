import { mergeRslibConfig, type RslibConfig } from "@rslib/core";

// mergeRslibConfig 的参数类型（RslibConfigWithOptionalLib）未从包入口导出，从函数签名推导。
type RslibConfigOverrides = Parameters<typeof mergeRslibConfig>[number];

// 所有 Rslib workspace 共享的 bundleless 基线（Issue #34）。
const baseConfig: RslibConfig = {
  lib: [
    {
      // mergeRslibConfig 只按 id 合并 lib 数组项，无 id 的项会被追加而不是合并，
      // 所以基线必须固定 id；"esm" 与 Rslib 给单个 esm 产物分配的默认环境名一致，
      // 不会改变产物行为。
      id: "esm",
      bundle: false,
      dts: { tsgo: true },
      externalHelpers: true,
      format: "esm",
      syntax: "esnext",
    },
  ],
  output: { target: "node" },
};

export function defineLibraryConfig(overrides?: RslibConfigOverrides): RslibConfig {
  const merged = mergeRslibConfig(baseConfig, overrides);
  // baseConfig 固定提供 lib，合并结果必然带 lib，但 mergeRslibConfig 的返回类型
  // 表达不了这个不变量，这里用 ?? 窄化回 RslibConfig。
  return { ...merged, lib: merged.lib ?? baseConfig.lib };
}
