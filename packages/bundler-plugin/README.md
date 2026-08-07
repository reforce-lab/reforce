# @reforce/bundler-plugin

Starter 库作者的构建收尾插件（ADR 0004，[#120](https://github.com/reforce-lab/reforce/issues/120)）。
在打包器写完 dist 后运行 Reforce 库模式编译，把契约面产物写进输出目录，并补/校正
`package.json` 的 exports subpath：

- `reforce-meta.json` —— 预编译 bean 注册表，应用编译器在链接期归并（subpath `./reforce-meta`）。

`defineApplication({ starters: [...] })` 用的注册 handle 不是产物：包作者在主入口手写
`export const <槽名> = defineStarter()`（`@reforce/core`），使用者具名 import 它。

收尾最后用 [publint](https://publint.dev) 校验发布产物（`pack: false`，纯文件系统校验，
不拉起包管理器），error 级问题直接判失败，兜住 exports/main 指向缺失文件这类事故；
`files` 字段是否漏发 dist 属发布前检查，请在发布流水线另跑 `publint` CLI。

## 用法

两个插件面共享同一份收尾逻辑，按打包器选择：

**rslib / rsbuild（rspack 系）走 rsbuild 原生面。** unplugin 的 `writeBundle` 在 rspack 映射到
afterEmit，早于 tsgo 写完 d.ts，而库模式编译读 dist 声明面，必报 `INVALID_LIBRARY_PACKAGE`
（[#185](https://github.com/reforce-lab/reforce/issues/185)）；原生面的 `onAfterBuild` 在 dts
完成后才触发：

```ts
// rslib.config.ts
import { reforceStarterRsbuild } from "@reforce/bundler-plugin/rsbuild";

export default {
  lib: [{ bundle: false, dts: { tsgo: true }, format: "esm" }],
  plugins: [reforceStarterRsbuild()],
};
```

**其余打包器（Vite/Rollup/Rolldown/esbuild/Farm/Bun 等）走 unplugin 面**，按打包器取对应工厂：

```ts
// vite.config.ts
import { reforceStarter } from "@reforce/bundler-plugin";

export default {
  plugins: [reforceStarter.vite()],
};
```

```ts
// Bun.build
await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  plugins: [reforceStarter.bun()],
});
```

选项（两个面一致）：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `projectDirectory` | 进程工作目录 | 库项目根（含 `package.json` 与 leaf tsconfig） |
| `tsconfigPath` | 自动选择 | 显式指定 leaf tsconfig，相对 `projectDirectory` 解析 |
| `outputDirectory` | `"dist"` | meta 的写入目录，相对项目根；`"."` 即包根布局 |
| `exports` | `"patch"` | `"patch"` 补/校正 package.json 的 subpath；`"verify"` 只校验不改写 |
| `publint` | `true` | 关闭发布产物校验 |

不用打包器的作者直接跑 CLI：`reforce lib --project .`（产物写在包根，exports 需自行声明，
CLI 只校验不改写）。

## 作者约定

- **先建 dist 再收尾**：库模式编译从已构建的 dist d.ts 反推公开符号表与 `runtimeExport`，
  并交叉核对源码与 dist 的形状；请把本插件放在产出声明文件的构建之后。
- **契约包 peer 化**（ADR 0004 决策 9）：跨 starter 共享的契约放独立 types-only 包，starter 以
  `peerDependencies` 引用。peer 强制全树单一解析，版本撕裂在 install 时就被包管理器拦下；
  同名包出现两份物理拷贝时，编译器按两个身份处理、不合并。
- **meta v1 只表达类构造 bean**：`defineBean` 工厂、`@Primary` / `@Qualifier`、`Lazy` 注入在
  库模式下是编译错误；应用要覆盖 starter，只需声明本地 provider（本地恒胜）。
