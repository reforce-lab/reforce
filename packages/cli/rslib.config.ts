import { defineLibraryConfig } from "@reforce/tooling-rslib";

export default defineLibraryConfig({
  lib: [{ id: "esm", dts: false }],
  output: {
    cleanDistPath: true,
    distPath: { root: "dist" },
    // minify: false 不是默认值：不显式关闭时 Rslib 默认压缩配置仍会跑 dead_code/unused
    // 等 compress pass，CLI dist 需要保持原样便于排查。
    minify: false,
    sourceMap: false,
  },
});
