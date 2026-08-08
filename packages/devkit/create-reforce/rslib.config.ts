import { defineLibraryConfig } from "@reforce/tooling-rslib";

// 与 @reforce/cli 同款 bin 产物配置：不生成 d.ts（没有下游 package 消费本包的类型），
// 不压缩以便排查用户报回来的堆栈。templates/ 不进 src，rslib 不编译它——它是原样随
// `files` 发布的模板资产，由 src/templates-root.ts 在运行时定位。
export default defineLibraryConfig({
  // externalHelpers 关掉是有意偏离仓库基线：开着就得把 @swc/helpers 声明成运行时依赖，
  // 而 `pnpm create reforce` 每次执行都要现装这个包的依赖树。本包没有装饰器，helper 量
  // 小到内联更划算——少一个依赖 > 省几行产物。
  lib: [{ id: "esm", dts: false, externalHelpers: false }],
  output: {
    cleanDistPath: true,
    distPath: { root: "dist" },
    minify: false,
    sourceMap: false,
  },
});
