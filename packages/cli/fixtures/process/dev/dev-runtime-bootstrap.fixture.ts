import type { RspackHmrRuntime } from "../../../src/dev-hmr-manager";
import { runDevelopmentApplication } from "../../../src/dev-runtime";

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
        throw new Error("bootstrap fixture failed");
      },
    };
  },
});
