---
description: Reforce workspace 的源码、测试目录、TypeScript 与 Rslib 边界
applyTo: "packages/**,platforms/**,tooling/**"
---

- Workspace 生产源码只放 `src/`；单元测试放 `test/`，集成测试放 `it/`，包内不建立 `fixtures/` 或 `e2e/`。
- `src/` 中禁止 `*.spec.ts` 和 `*.test.ts`。只创建实际需要的 `test/`、`it/` 及其 `tsconfig.json`，不创建空测试层。
- 指向同 workspace `src` 的 import 使用 `@/*`；跨 workspace 使用 `@reforce/*`。测试 support 内部和生成的 production `.js` specifier 可以使用相对路径。
- 类私有成员使用 TypeScript `private` / `private readonly`，禁止 ES `#field` / `#method`；仅初始化一次的字段优先 `private readonly`。
- Rslib workspace 的根 `tsconfig.json` 只管理 `src`，设置 `rootDir: "./src"`；根 `tsconfig.node.json` 管理 `src` 和 Rslib/tooling 配置。所有配置继承共享基线的 `noEmit: true`。
- 不使用 project references、`composite` 或 `tsconfig.build.json`。`test/tsconfig.json`、`it/tsconfig.json` 继承 `../tsconfig.node.json` 并只 include 当前目录。
- 普通 Rslib 配置自动读取根 `tsconfig.json`，不设置 `source.tsconfigPath`。Library d.ts 使用 TSGo bundleless，不设置 `bundle`；**公开**声明（`package.json#exports` 里列出的那些）位于 `dist/` 根目录，bundleless d.ts 同时按 `src` 结构在 `dist/<domain>/` 下产出内部声明，属预期行为。
- package exports 不保留仓库专用源码 condition；跨 workspace 的 Unit/IT 由 Turbo 先构建上游依赖后消费 `dist`。

## `src/` 目录布局

`packages/compiler/src` 是参照实现：根放 `index.ts`(entry) + 入口实现 + 被多个领域 import 的词汇模块，领域目录按流水线阶段命名（`parser/ analysis/ linking/ emission/ project/`）。

- `src/` 根只放三类文件：(a) Rslib `source.entry` 指向的入口模块；(b) 被一个以上领域目录或入口 import 的包级共享词汇模块；(c) 用 `import.meta.url` 反推包内路径的模块——它依赖「自己在包根下一层」，源码执行（`src/`）与构建产物（`dist/`）深度必须一致，进领域目录就会解析到 `src/<domain>/../dist`。这类文件必须在同处注释写明该约束。只有单一归属的其他模块一律进领域目录。
- 目录按领域或流水线阶段命名，不按文件类型命名。禁止 `utils/`、`helpers/`、`types/`、`services/`、`common/`。
- 目录名是要从文件名里删掉的前缀：`src/dev-watch-build.ts` → `src/dev/watch-build.ts`，禁止 `dev/dev-watch-build.ts` 这种叠词。
- 一个目录成立的条件：≥3 个文件构成一个有名字的阶段，**或**能从 ≥2 个文件上消掉共同前缀。不满足就保持扁平，不为形式统一建目录或占位文件。
- 深度上限一层 `src/<domain>/<file>.ts`；某个领域超过约 10 个文件才考虑第二层。
- 每个 Rslib entry 一个 barrel，禁止目录级 barrel。不允许 `src/dev/index.ts` 这类文件——它制造 `a → dev/index → b → a` 循环并让 import 图不可读。包内 import 直达文件：`@/dev/watch-build`。
- `export` 的含义是"包内另一个模块 import 了它"，不是"以后可能有用"。只在本文件使用的辅助函数不加 `export`（Biome 的 `noUnusedVariables` 不检查已导出符号，多余的 `export` 会让死代码永久隐形）。仅为测试而导出属坏味道；确需时必须写注释说明为什么无法经真实入口触达。
