// 本文件由 Node 子进程直接执行（type stripping，不读 tsconfig paths）：值导入一律指向包内
// dist 产物或带显式 .ts 扩展名的相对路径；type-only 导入会被擦除，保留 @/ 别名（#207）。

import type { RspackHmrRuntime } from "@/hmr-manager";
import { runDevelopmentApplication } from "../../../../dist/dev-runtime.js";

const hot: RspackHmrRuntime = {
  async check() {
    return null;
  },
  async apply() {},
};

process.exitCode = await runDevelopmentApplication({
  hot,
  async loadBootstrap() {
    return {
      async bootstrap() {
        throw new Error("bootstrap harness failed");
      },
    };
  },
});
