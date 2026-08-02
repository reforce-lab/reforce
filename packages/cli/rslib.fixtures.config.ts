import { defineConfig } from "@rslib/core";

export default defineConfig({
  lib: [
    {
      dts: false,
      externalHelpers: true,
      format: "esm",
      syntax: "esnext",
    },
  ],
  output: {
    distPath: { root: "fixtures/dist" },
    filename: { js: "[name].js" },
    filenameHash: false,
    target: "node",
  },
  source: {
    entry: {
      "process/dev/dev-child-exit.fixture": "./fixtures/process/dev/dev-child-exit.fixture.ts",
      "process/dev/dev-child-shutdown.fixture":
        "./fixtures/process/dev/dev-child-shutdown.fixture.ts",
      "process/dev/dev-child-startup-failure.fixture":
        "./fixtures/process/dev/dev-child-startup-failure.fixture.ts",
      "process/dev/dev-command.fixture": "./fixtures/process/dev/dev-command.fixture.ts",
      "process/dev/dev-entry.fixture": "./fixtures/process/dev/dev-entry.fixture.ts",
      "process/dev/dev-runtime-bootstrap.fixture":
        "./fixtures/process/dev/dev-runtime-bootstrap.fixture.ts",
      "process/dev/dev-runtime-handshake.fixture":
        "./fixtures/process/dev/dev-runtime-handshake.fixture.ts",
      "process/lease/project-lease.fixture": "./fixtures/process/lease/project-lease.fixture.ts",
      "process/lease/project-lease-participant.fixture":
        "./fixtures/process/lease/project-lease-participant.fixture.ts",
      "process/production/production-runtime-order.fixture":
        "./fixtures/process/production/production-runtime-order.fixture.ts",
      "process/windows-signal.fixture": "./fixtures/process/windows-signal.fixture.ts",
    },
    tsconfigPath: "./tsconfig.json",
  },
  tools: {
    rspack(config) {
      config.experiments ??= {};
      config.experiments.topLevelAwait = true;
    },
  },
});
