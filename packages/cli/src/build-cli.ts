import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRsbuild, rspack } from "@rsbuild/core";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const rsbuild = await createRsbuild({
  cwd: cliRoot,
  callerName: "reforce-cli",
  config: {
    mode: "production",
    logLevel: "error",
    source: {
      decorators: { version: "2022-03" },
      entry: {
        "dev-runtime": "./src/dev-runtime.ts",
        "production-runtime": "./src/production-runtime.ts",
        reforce: "./src/reforce.ts",
      },
    },
    output: {
      target: "node",
      module: true,
      autoExternal: {
        dependencies: true,
        packageJson: [
          "./package.json",
          "../compiler/package.json",
          "../compiler-spi/package.json",
          "../compiler-yuku/package.json",
          "../context/package.json",
        ],
        exclude: [/^@reforce\//u],
      },
      distPath: { root: "dist", js: "", jsAsync: "" },
      filename: { js: "[name].js" },
      filenameHash: false,
      sourceMap: false,
      legalComments: "none",
      cleanDistPath: true,
      minify: false,
    },
    performance: {
      printFileSize: false,
    },
    splitChunks: false,
    tools: {
      rspack(config) {
        config.plugins ??= [];
        config.plugins.push(
          new rspack.BannerPlugin({
            banner: "#!/usr/bin/env node",
            entryOnly: true,
            include: /reforce\.js$/u,
            raw: true,
          }),
        );
        config.optimization ??= {};
        config.optimization.runtimeChunk = false;
        config.output ??= {};
        config.output.chunkLoading = false;
        config.resolve ??= {};
        config.resolve.conditionNames = ["development", "node", "import", "module", "default"];
      },
    },
  },
});

const result = await rsbuild.build();
await result.close();
await chmod(join(cliRoot, "dist", "reforce.js"), 0o755);
