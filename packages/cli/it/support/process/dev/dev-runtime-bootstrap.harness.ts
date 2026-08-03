import { runDevelopmentApplication } from "@/dev-runtime";
import type { RspackHmrRuntime } from "@/runtime/hmr-manager";

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
