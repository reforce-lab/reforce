// 本文件由 Node 子进程直接执行（type stripping，不读 tsconfig paths）：值导入一律指向包内
// dist 产物或带显式 .ts 扩展名的相对路径；type-only 导入会被擦除，保留 @/ 别名（#207）。

import type { RspackHmrRuntime } from "@/hmr-manager";
import { runDevelopmentApplication } from "../../../../dist/dev-runtime.js";
import { observeShutdownSignals } from "../signal-observer.ts";

const onMessage = (message: unknown) => {
  if (
    typeof message !== "object" ||
    message === null ||
    Reflect.get(message, "type") !== "harness:barrier" ||
    typeof Reflect.get(message, "requestId") !== "string"
  ) {
    return;
  }
  process.send?.({
    type: "harness:barrier-ack",
    requestId: Reflect.get(message, "requestId"),
  });
};
process.on("message", onMessage);

const stopObservingSignals = observeShutdownSignals();

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
        process.send?.({ type: "harness:bootstrap" });
        return {
          async close() {
            process.send?.({ type: "harness:closed" });
          },
        };
      },
    };
  },
});

process.off("message", onMessage);
stopObservingSignals();
