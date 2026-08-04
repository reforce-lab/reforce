import { createUnplugin, type UnpluginInstance } from "unplugin";
import { finishStarterBuild, type ReforceStarterOptions } from "@/finish";

// 一份插件适配 unplugin 支持的打包器（ADR 0004 决策 4，#120）：库模式编译只依赖已写盘的
// dist 与 package.json，所以全部工作都在收尾钩子里做，不参与 transform/load 管线。
// rspack 系（rslib/rsbuild）除外：unplugin 把 writeBundle 映射到 rspack 的 afterEmit，早于
// tsgo 写完 d.ts，而库模式编译读 dist 声明面，必报 INVALID_LIBRARY_PACKAGE（#185）——
// rslib/rsbuild 作者走 "./rsbuild" 的原生面。

export type { ReforceStarterOptions } from "@/finish";

export const reforceStarter: UnpluginInstance<ReforceStarterOptions | undefined> = createUnplugin(
  (options = {}) => ({
    name: "reforce-starter",
    writeBundle: () => finishStarterBuild(options),
  }),
);

export default reforceStarter;
