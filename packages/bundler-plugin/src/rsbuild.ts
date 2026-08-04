import { finishStarterBuild, type ReforceStarterOptions } from "@/finish";

// rsbuild 原生面（ADR 0004 决策 4，#120/#185）：rslib/rsbuild 的 d.ts 由 tsgo 在 rspack
// compilation 之外生成，unplugin 把 writeBundle 映射到 rspack 的 afterEmit、早于 d.ts 落盘，
// 而库模式编译读 dist 声明面——rspack 系必须走本面，onAfterBuild 在 dts 完成后才触发。
// 只声明用到的结构面、不引入 @rsbuild/core 依赖：rsbuild 按结构消费插件对象，
// 真实的 RsbuildPluginAPI 结构性满足 StarterFinishApi。

export type { ReforceStarterOptions } from "@/finish";

interface StarterFinishApi {
  onAfterBuild(hook: () => Promise<void>): void;
}

export interface ReforceStarterRsbuildPlugin {
  readonly name: string;
  setup(api: StarterFinishApi): void;
}

export function reforceStarterRsbuild(
  options: ReforceStarterOptions = {},
): ReforceStarterRsbuildPlugin {
  return {
    name: "reforce-starter",
    setup(api) {
      api.onAfterBuild(() => finishStarterBuild(options));
    },
  };
}
