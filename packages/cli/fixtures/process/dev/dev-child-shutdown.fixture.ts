import type { Reporter } from "#internal/reporter";
import { installProcessShutdownHandlers, ShutdownController } from "#internal/shutdown-controller";

const reporter: Reporter = {
  report() {},
  async flush() {},
};
const controller = new ShutdownController({ command: "dev", reporter });
installProcessShutdownHandlers(controller);
await controller.start(async () => ({
  async close() {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  },
}));
process.send?.({ type: "reforce:dev-ready" });
const result = await controller.finished;
await new Promise<void>((resolve) => setImmediate(resolve));
if (process.connected) {
  process.disconnect?.();
}
process.exitCode = result.exitCode;
