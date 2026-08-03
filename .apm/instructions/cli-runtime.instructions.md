---
description: Reforce CLI 对用户 Rsbuild mode、dist 与动态运行时模块的边界
applyTo: "packages/cli/**"
---

- Rsbuild 的 `development` / `production` 只表示用户应用模式，不表示 Reforce 源码模式；CLI dev/build 始终消费 Reforce dist。
- 禁止向用户 Rsbuild 手写 `conditionNames`；用户选择的 leaf tsconfig 仍需动态传给 Rsbuild。
- 动态运行时使用 `reforce:dev-runtime` / `reforce:production-runtime`，通过精确模块 replacement 映射；禁止用宽泛 `resolve.alias` 代替。
- 从 `production-runtime.ts` **经真实 import 链**可达的源码，注释里禁止出现 `@reforce/compiler`、`createCompiler`、`PARSER_SYNTAX_ERROR`、`yuku-parser`：CLI dist 与用户 production build 都是 `minify: false`，注释原样进入用户 dist，会触发 `it/integration/production-build.spec.ts` 的「产物不含构建期依赖」断言（Issue #22）。挂在纯类型声明上的注释随类型一起擦除，不在此限。
  - 当前可达集：`bun-runtime` / `project/lease-endpoint` / `reporter` / `runtime/shutdown-controller` / `dev-ipc`（`shutdown-controller` import 它）。CLI 自 #34 起是 bundleless，不再有共享 chunk 把无关文件一起拖进来——这个集合就是 import 图本身，改 import 就会变。
