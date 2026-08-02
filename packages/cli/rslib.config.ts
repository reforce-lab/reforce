import { defineConfig } from "@rslib/core";

export default defineConfig({
  lib: [
    {
      autoExternal: false,
      dts: false,
      externalHelpers: true,
      format: "esm",
      id: "cli",
      source: { entry: { reforce: "./src/reforce.ts" } },
      syntax: "esnext",
    },
    {
      autoExternal: false,
      dts: false,
      externalHelpers: true,
      format: "esm",
      id: "runtime",
      source: {
        entry: {
          "dev-runtime": "./src/dev-runtime.ts",
          "production-runtime": "./src/production-runtime.ts",
        },
      },
      syntax: "esnext",
    },
  ],
  output: {
    autoExternal: {
      dependencies: true,
      exclude: ["@reforce/context"],
    },
    cleanDistPath: true,
    distPath: { js: "", jsAsync: "", root: "dist" },
    filename: { js: "[name].js" },
    filenameHash: false,
    minify: false,
    sourceMap: false,
    target: "node",
  },
  tools: {
    rspack(config) {
      config.optimization ??= {};
      config.optimization.runtimeChunk = false;
      config.optimization.splitChunks = false;
      config.output ??= {};
      config.output.chunkLoading = false;
    },
  },
});
