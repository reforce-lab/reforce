import { runProductionApplication } from "@/production-runtime";
import type { Reporter } from "@/reporter";

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
const signalNames: NodeJS.Signals[] =
  process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
const onSignal = (signal: NodeJS.Signals) => {
  process.send?.({ type: "harness:signal-observed", signal });
};
for (const signal of signalNames) {
  process.on(signal, onSignal);
}

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
      async start() {},
      get() {
        throw new Error("The production runtime ordering harness has no Beans.");
      },
      async close() {
        process.send?.({ type: "harness:application-closed" });
      },
    };
  },
  { reporter },
);
process.off("message", onMessage);
for (const signal of signalNames) {
  process.off(signal, onSignal);
}
process.send?.({ type: "harness:returned" });
await new Promise<void>((resolve) => setImmediate(resolve));
if (process.connected) {
  process.disconnect?.();
}
