// 本文件由 Node 子进程直接执行（type stripping，不读 tsconfig paths）：值导入一律指向包内
// dist 产物或带显式 .ts 扩展名的相对路径；type-only 导入会被擦除，保留 @/ 别名（#207）。

import type { Reporter } from "@/reporter";
import { runProductionApplication } from "../../../../dist/production-runtime.js";
import { observeShutdownSignals } from "../signal-observer.ts";

const flushContinuation = Promise.withResolvers<void>();
const onMessage = (message: unknown) => {
  if (typeof message !== "object" || message === null) {
    return;
  }
  if (Reflect.get(message, "type") === "harness:continue-flush") {
    flushContinuation.resolve();
    return;
  }
  if (
    Reflect.get(message, "type") === "harness:barrier" &&
    typeof Reflect.get(message, "requestId") === "string"
  ) {
    process.send?.({
      type: "harness:barrier-ack",
      requestId: Reflect.get(message, "requestId"),
    });
  }
};
process.on("message", onMessage);
const stopObservingSignals = observeShutdownSignals();

const reporter: Reporter = {
  report() {},
  async flush() {
    process.send?.({ type: "harness:flush-entered" });
    await flushContinuation.promise;
  },
};

await runProductionApplication(
  async () => {
    process.send?.({ type: "harness:ready" });
    return {
      async start() {
        return { beanTimings: [] };
      },
      get() {
        throw new Error("The production runtime ordering harness has no Beans.");
      },
      async runInRequestScope(): Promise<never> {
        throw new Error("The production runtime ordering harness has no request scope.");
      },
      async close() {
        process.send?.({ type: "harness:application-closed" });
      },
    };
  },
  { reporter },
);
process.off("message", onMessage);
stopObservingSignals();
process.send?.({ type: "harness:returned" });
await new Promise<void>((resolve) => setImmediate(resolve));
if (process.connected) {
  process.disconnect?.();
}
