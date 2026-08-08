import { defineLibraryConfig } from "@reforce/tooling-rslib";

// dist 经模块替换原样进入用户 dev/production 产物（ADR 0009，#191）：显式关闭 minify——
// 不显式关闭时 Rslib 默认压缩配置仍会跑 dead_code 等 compress pass 并剥注释，而本包的
// 注释纪律要求注释原样进产物（#22，断言在 cli 的 it/integration/production-build.spec.ts）。
export default defineLibraryConfig({
  output: { minify: false },
});
