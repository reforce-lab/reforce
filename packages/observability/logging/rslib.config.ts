import { reforceStarterRsbuild } from "@reforce/bundler-plugin/rsbuild";
import { defineLibraryConfig } from "@reforce/tooling-rslib";

// 普通 starter（#347）：meta 由 reforce lib 随 build 产出，不再手写。
//
// 此前接不上生成器的原因是依赖环——接插件要 devDepend @reforce/bundler-plugin，于是
// logging → bundler-plugin → compiler →（devDep）config → logging。契约与引导期设施拆进
// @reforce/logging-contracts 之后 config 不再依赖本包，那条边随之消失。
export default defineLibraryConfig({
  plugins: [
    reforceStarterRsbuild({
      tsconfigPath: "tsconfig.json",
      outputDirectory: ".",
      exports: "verify",
      publint: false,
    }),
  ],
});
