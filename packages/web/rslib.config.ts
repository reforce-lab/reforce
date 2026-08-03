import { defineConfig } from "@rslib/core";

export default defineConfig({
  lib: [
    {
      bundle: false,
      dts: { tsgo: true },
      externalHelpers: true,
      format: "esm",
      syntax: "esnext",
    },
  ],
  output: { target: "node" },
});
