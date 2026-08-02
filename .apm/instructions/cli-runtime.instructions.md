---
description: Reforce CLI 对用户 Rsbuild mode、dist 与动态运行时模块的边界
applyTo: "packages/cli/**"
---

- Rsbuild 的 `development` / `production` 只表示用户应用模式，不表示 Reforce 源码模式；CLI dev/build 始终消费 Reforce dist。
- 禁止向用户 Rsbuild 手写 `conditionNames`；用户选择的 leaf tsconfig 仍需动态传给 Rsbuild。
- 动态运行时使用 `reforce:dev-runtime` / `reforce:production-runtime`，通过精确模块 replacement 映射；禁止用宽泛 `resolve.alias` 代替。
