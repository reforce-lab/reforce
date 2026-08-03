# 🌱 Reforce

> 面向 Bun 时代的「Spring 式」应用框架生态。
> A Spring-like application framework ecosystem for the Bun era.

Reforce 是一个**长期项目**，目标是把 Spring 生态中被验证过的核心理念——IoC 容器、声明式装配、配置抽象、生命周期管理、自动装配（starter）、测试支持——用现代 TypeScript 工具链重新实现，而不是照搬 Java 的形制。

## 工作原则

1. **不迷信旧知识**：任何版本、特性、API 的结论，都以联网核实的当前事实为准，并写明信息日期。
2. **第一性原理**：先问"这个问题在 2026 年的 JS 运行时里本质是什么"，再决定借鉴还是摒弃 Spring 的做法。
3. **GitHub 是唯一知识来源**：需求 → Issues，规划 → Projects，决策 → ADR issue（**issue 即文档**，顶楼保持最新），长期知识 → Wiki。对话里的结论不落盘就当作不存在。

## 技术栈基线（2026-08-02 核实）

| 领域 | 选型 | 版本 |
| --- | --- | --- |
| 包管理 / CLI / 应用运行时 | Bun | 1.3.14 |
| 任务编排 / 缓存 | Turborepo | 2.10.8 |
| 语言 | TypeScript（Go 原生编译器，2026-07-08 GA） | 7.0.2 |
| Compiler 内置 parser | Yuku Parser | 0.8.3 |
| Package 构建 | Rslib（SWC + TSGo d.ts） | 0.23.2 |
| SWC 运行时 helpers | @swc/helpers | 0.5.23 |
| 测试 | Bun test（内置 runner，与运行时同引擎） | 随 bun 1.3.14 |
| Lint / Format | Biome | 2.5.6 |
| 提交规范 | commitlint（Conventional Commits） | 21.2.1 |
| Git hooks | lefthook | 2.1.10 |

选型理由与已知坑见 [ADR 0001 · 技术栈基线](https://github.com/reforce-lab/reforce/issues/9)。

## 仓库结构

```
reforce/
├── e2e/                   # @reforce/e2e —— 只消费 dist 的完整用户链路
│   └── fixtures/
│       └── application/   # 由 E2E workspace 管理的唯一完整应用模板
├── packages/
│   ├── cli/               # @reforce/cli —— 命令行工具
│   ├── compiler/          # @reforce/compiler —— 内置 Yuku parser、项目解析、链接、分析与生成
│   ├── context/           # @reforce/context —— IoC 容器 / ApplicationContext
│   ├── contracts/         # @reforce/contracts —— 跨包共享合同（占位）
│   ├── primitives/        # @reforce/primitives —— 跨包共享的排序与路径原语
│   ├── testing/           # @reforce/testing —— 框架测试支持
│   └── web/               # @reforce/web —— Web 抽象
├── platforms/
│   ├── fastify/           # @reforce/platform-fastify —— Fastify 适配
│   └── hono/              # @reforce/platform-hono —— Hono 适配
├── tooling/
│   ├── testing/           # @reforce/tooling-testing —— 跨平台进程与临时项目工具
│   └── tsconfig/          # @reforce/tooling-tsconfig —— workspace tsconfig 的共享基线
└── .github/               # CI、Issue / PR 模板、CODEOWNERS
```

> 文档不进代码仓库：决策记录在 [ADR issues](https://github.com/reforce-lab/reforce/issues?q=label%3A%22type%3A+adr%22)，长期知识在 [Wiki](https://github.com/reforce-lab/reforce/wiki)。

Compiler 内置并只使用 Yuku parser，不提供 parser 选择或备用解析路径；选型依据与维护边界见
[ADR 0003](https://github.com/reforce-lab/reforce/issues/13)。Parser 与 Source IR 都是 Compiler 内部实现，
应用的 production artifact 不包含 Compiler 或 parser。

## 快速开始

```bash
bun install
bun run check:write
bun run check
bun run typecheck
bun run test
bun run build
bun run test:e2e
bun packages/cli/dist/reforce.js --help
```

每个 Rslib workspace 的根 `tsconfig.json` 只管理 `src`，`tsconfig.node.json` 管理源码与 Rslib/tooling 配置；两者都继承 `@reforce/tooling-tsconfig/base.json` 的 `noEmit: true`，不使用 project references。Rslib 自动读取源码配置并负责生成 Bun 可执行的服务端 ESM 和根级 bundleless d.ts。package 内指向自身 `src` 的 import 统一写成 `@/...`，跨 package 使用 `@reforce/*`；只有 Compiler 写入应用 production output 的相对 module specifier 使用 `.js`。类私有成员使用 TypeScript `private` / `private readonly`，不使用 ES `#field` / `#method` 语法。

包级单元测试位于 `test/`，路径严格镜像 `src`；跨模块、filesystem、子进程和 Worker 行为位于 `it/`。两个目录各自维护 `tsconfig.json`。默认 `bun run test` 运行 unit 与 IT；独立的 `@reforce/e2e` workspace 通过 `bun run test:e2e` 从构建后的 CLI 验证完整用户链路。

package exports 只公开 `dist`。仓库内跨 package import、CLI dev/build 和用户应用都消费构建产物；Rsbuild 的 `development` / `production` mode 只描述用户应用是否启用开发能力，不改变 Reforce package 的解析入口。

应用只需使用仓库统一的标准 decorators 配置；不启用旧 decorators，也不生成 runtime metadata：

```json
{
  "extends": "@reforce/tooling-tsconfig/base.json",
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src", ".reforce/generated/**/*.d.ts"]
}
```

```ts
import { Injectable, type OnContextClose, type OnContextStart } from "@reforce/context";

@Injectable()
export class GreetingService implements OnContextStart, OnContextClose {
  onContextStart(): void {}
  onContextClose(): void {}
}
```

一个 application project 等于一个有效的 leaf tsconfig，其所在目录就是该应用的 canonical project root。standalone 与 monorepo 使用同一组命令：

```bash
reforce dev --project .
reforce build --project apps/api --tsconfig tsconfig.json
reforce start --project apps/api
```

`--tsconfig` 相对 `--project` 解析；显式传入嵌套 config 后，输出仍固定写入该 leaf application 目录的 `.reforce/generated`、`.reforce/dev` 与 `dist`。`start` 只读取该目录的完整 production artifact，不读取 tsconfig。

`e2e/fixtures/application` 是唯一完整应用模板，由 `@reforce/e2e` workspace 提供依赖和检查。E2E 会先把项目输入复制到临时目录，再生成、修改或启动；包内不保存 fixture，Compiler 项目输入与进程/Worker harness 都由相应 IT 在临时目录构造。

## 参与方式

见 [CONTRIBUTING.md](CONTRIBUTING.md)。所有需求与讨论以 GitHub Issues / Projects 为准。
