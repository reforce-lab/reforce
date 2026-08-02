import { defineConfig } from "@rslib/core";

export default defineConfig({
  lib: [
    {
      dts: {
        bundle: true,
        tsgo: true,
      },
      externalHelpers: true,
      format: "esm",
      syntax: "esnext",
    },
  ],
  output: {
    target: "node",
  },
  source: {
    tsconfigPath: "./tsconfig.build.json",
  },
});
