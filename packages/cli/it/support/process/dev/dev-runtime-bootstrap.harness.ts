import type { RspackHmrRuntime } from "@/dev-hmr-manager";
import { runDevelopmentApplication } from "@/dev-runtime";

const hot: RspackHmrRuntime = {
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
        throw new Error("bootstrap harness failed");
      },
    };
  },
});
