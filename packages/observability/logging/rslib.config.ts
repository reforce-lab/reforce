import { defineLibraryConfig } from "@reforce/tooling-rslib";

// 是 starter，但 meta 手写（#242 勘误把本包升格 starter，reforce-meta.json 里那两个 bean 就是
// 它的注册面）。这里没有 reforceStarterRsbuild、也没有包级 turbo.json，原因是依赖环而不是
// 生成器能力：接上插件要 devDepend @reforce/bundler-plugin，于是
// logging → bundler-plugin → compiler →（devDep）config → logging 成环，turbo 拒绝构建。
// @Fallback()（#343）已经让 reforce lib 能产出 defaultBean，缺的只是这条边能不能连。
// 按角色拆包见 #347。
export default defineLibraryConfig();
