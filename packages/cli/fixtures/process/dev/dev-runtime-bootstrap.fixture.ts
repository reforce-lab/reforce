import type { NodeHmrRuntime } from "#internal/dev-hmr-manager";
import { runDevelopmentApplication } from "#internal/dev-runtime";

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
        throw new Error("bootstrap fixture failed");
      },
    };
  },
});
