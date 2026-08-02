# 🌱 Reforce

> 面向 Node.js / Bun 时代的「Spring 式」应用框架生态。
> A Spring-like application framework ecosystem for the Node.js / Bun era.

Reforce 是一个**长期项目**，目标是把 Spring 生态中被验证过的核心理念——IoC 容器、声明式装配、配置抽象、生命周期管理、自动装配（starter）、测试支持——用现代 TypeScript 工具链重新实现，而不是照搬 Java 的形制。

## 工作原则

1. **不迷信旧知识**：任何版本、特性、API 的结论，都以联网核实的当前事实为准，并写明信息日期。
2. **第一性原理**：先问"这个问题在 2026 年的 JS 运行时里本质是什么"，再决定借鉴还是摒弃 Spring 的做法。
3. **GitHub 是唯一知识来源**：需求 → Issues，规划 → Projects，决策 → ADR issue（**issue 即文档**，顶楼保持最新），长期知识 → Wiki。对话里的结论不落盘就当作不存在。

## 技术栈基线（2026-08-02 核实）

| 领域 | 选型 | 版本 |
| --- | --- | --- |
| 包管理 / 运行时 | Bun | 1.3.14 |
| CLI runtime / production smoke | Node.js | 24.12.0 |
| 任务编排 / 缓存 | Turborepo | 2.10.8 |
| 语言 | TypeScript（Go 原生编译器，2026-07-08 GA） | 7.0.2 |
| 测试 | Bun test（内置 runner，与运行时同引擎） | 随 bun 1.3.14 |
| Lint / Format | Biome | 2.5.6 |
| 提交规范 | commitlint（Conventional Commits） | 21.2.1 |
| Git hooks | lefthook | 2.1.10 |

选型理由与已知坑见 [ADR 0001 · 技术栈基线](https://github.com/reforce-lab/reforce/issues/9)。

## 仓库结构

```
reforce/
├── packages/
│   ├── cli/               # @reforce/cli —— 命令行工具
│   ├── compiler/          # @reforce/compiler —— 项目解析、链接、分析与生成
│   │   └── fixtures/      # 两套 frontend 与完整 Compiler 共用的 conformance corpus
│   ├── compiler-spi/      # @reforce/compiler-spi —— frontend Source IR 合同
│   ├── compiler-babel/    # Babel frontend 与 conformance / benchmark
│   ├── compiler-yuku/     # 默认 Yuku frontend
│   ├── context/           # @reforce/context —— IoC 容器 / ApplicationContext
│   ├── testing/           # @reforce/testing —— 框架测试支持
│   └── web/               # @reforce/web —— Web 抽象
├── platforms/
│   ├── fastify/           # @reforce/platform-fastify —— Fastify 适配
│   └── hono/              # @reforce/platform-hono —— Hono 适配
├── tooling/
│   ├── testing/           # @reforce/tooling-testing —— 跨平台真实进程 / filesystem fixture
│   └── tsconfig/          # @reforce/tooling-tsconfig —— 唯一共享 TS 配置
└── .github/               # CI、Issue / PR 模板、CODEOWNERS
```

> 文档不进代码仓库：决策记录在 [ADR issues](https://github.com/reforce-lab/reforce/issues?q=label%3A%22type%3A+adr%22)，长期知识在 [Wiki](https://github.com/reforce-lab/reforce/wiki)。

## 快速开始

```bash
bun install
bun run check:write
bun run check
bun run typecheck
bun run test
bun run build
node packages/cli/dist/reforce.js --help
```

应用只需使用仓库统一的标准 decorators 配置；不启用旧 decorators，也不生成 runtime metadata：

```json
{
  "extends": "@reforce/tooling-tsconfig/base.json",
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

## 参与方式

见 [CONTRIBUTING.md](CONTRIBUTING.md)。所有需求与讨论以 GitHub Issues / Projects 为准。
