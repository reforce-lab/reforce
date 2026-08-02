import { defineConfig } from "@rslib/core";

export default defineConfig({
  lib: [
    {
      dts: { bundle: true, tsgo: true },
      externalHelpers: true,
      format: "esm",
      syntax: "esnext",
    },
  ],
  output: { target: "node" },
  source: {
    entry: {
      "generated-runtime": "./src/generated-runtime.ts",
      index: "./src/index.ts",
    },
    tsconfigPath: "./tsconfig.build.json",
  },
});
