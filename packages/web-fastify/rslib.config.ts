import { reforceStarterRsbuild } from "@reforce/bundler-plugin/rsbuild";
import { defineLibraryConfig } from "@reforce/tooling-rslib";

// starter 收尾走 rsbuild 原生面（ADR 0004 决策 4，#185/#193）：onAfterBuild 在 tsgo d.ts
// 落盘后运行库模式编译，meta 三件套写包根；exports 是手工声明的唯一契约，verify 只校验
// 不改写。publint 关闭：仓库构建不做发布前检查，发布流水线另跑 publint CLI。
export default defineLibraryConfig({
  plugins: [
    reforceStarterRsbuild({
      tsconfigPath: "tsconfig.json",
      outputDirectory: ".",
      exports: "verify",
      publint: false,
    }),
  ],
});
