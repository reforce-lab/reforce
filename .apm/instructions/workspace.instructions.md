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
- 普通 Rslib 配置自动读取根 `tsconfig.json`，不设置 `source.tsconfigPath`。Library d.ts 使用 TSGo bundleless，不设置 `bundle`；公开声明位于 `dist/` 根目录。
- package exports 不保留仓库专用源码 condition；跨 workspace 的 Unit/IT 由 Turbo 先构建上游依赖后消费 `dist`。
