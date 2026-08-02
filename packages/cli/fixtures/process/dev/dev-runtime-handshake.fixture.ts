import type { NodeHmrRuntime } from "#internal/dev-hmr-manager";
import { runDevelopmentApplication } from "#internal/dev-runtime";

const onMessage = (message: unknown) => {
  if (
    typeof message !== "object" ||
    message === null ||
    Reflect.get(message, "type") !== "fixture:barrier" ||
    typeof Reflect.get(message, "requestId") !== "string"
  ) {
    return;
  }
  process.send?.({
    type: "fixture:barrier-ack",
    requestId: Reflect.get(message, "requestId"),
  });
};
process.on("message", onMessage);

const signalNames: NodeJS.Signals[] =
  process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
const onSignal = (signal: NodeJS.Signals) => {
  process.send?.({ type: "fixture:signal-observed", signal });
};
for (const signal of signalNames) {
  process.on(signal, onSignal);
}

const hot: NodeHmrRuntime = {
  accept() {},
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
        process.send?.({ type: "fixture:bootstrap" });
        return {
          async close() {
            process.send?.({ type: "fixture:closed" });
          },
        };
      },
    };
  },
});

process.off("message", onMessage);
for (const signal of signalNames) {
  process.off(signal, onSignal);
}
