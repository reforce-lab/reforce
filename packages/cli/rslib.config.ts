import { defineConfig } from "@rslib/core";

export default defineConfig({
  lib: [
    {
      bundle: false,
      dts: false,
      externalHelpers: true,
      format: "esm",
      syntax: "esnext",
    },
  ],
  output: {
    cleanDistPath: true,
    distPath: { root: "dist" },
    minify: false,
    sourceMap: false,
    target: "node",
  },
});
