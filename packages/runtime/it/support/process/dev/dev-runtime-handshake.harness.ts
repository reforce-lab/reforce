import { runDevelopmentApplication } from "@/dev-runtime";
import type { RspackHmrRuntime } from "@/hmr-manager";
import { observeShutdownSignals } from "../signal-observer";

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
