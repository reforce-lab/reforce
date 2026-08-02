---
name: apm
description: 管理本仓库的 AI 上下文资产（instruction / skill / command / MCP / LSP）。当需要新增或修改 skill、指令、MCP、LSP、AGENTS.md，或安装第三方 agent 包时使用。所有上下文变更的唯一入口是 APM CLI，禁止直接手改编译产物。
---

# 上下文资产管理（APM）

本仓库的 AI 上下文由 [APM](https://github.com/microsoft/apm)（Agent Package Manager）统一管理。任何 coding runtime 新增/修改上下文资产，唯一入口是 APM，禁止绕过它直接手写各 runtime 的私有配置目录。

## 核心原则

1. **产物禁手改**：`AGENTS.md`、`.lsp.json`、`.claude/`、`.codex/` 等均为 `apm compile` / `apm install` 的产物。改源文件后重新编译/安装，否则下次编译会被覆盖。
2. **源文件只有两个去处**：`.apm/` 目录（内容型资产）和 `apm.yml`（声明型资产）。

## 资产类型与位置

| 资产 | 位置 | 触发方式 | 说明 |
|---|---|---|---|
| instruction / rule | `.apm/instructions/*.md` | 强制常驻 | frontmatter 的 `applyTo` glob 控制生效范围；`applyTo: "**"` 会全量编进 AGENTS.md，注意控制篇幅 |
| skill / command | `.apm/skills/<name>/SKILL.md` | frontmatter 决定 | 模型可自动触发 = skill；仅手动触发 = command。两者是同一种资产，不单列 prompt 类型 |
| MCP | `apm.yml` → `dependencies.mcp` | 运行时挂载 | `apm install` 写入各 runtime 的 MCP 配置 |
| LSP | `apm.yml` → `dependencies.lsp` | 运行时挂载 | `apm install` 生成 `.lsp.json`（Claude Code）等。当前声明：tsgo（`node_modules/.bin/tsc --lsp --stdio`，即 TS7 原生 LSP） |

第三方 skill / 包用 `apm install <pkg>` 安装，不手动拷贝。

## 常用命令

```bash
apm install          # 安装 apm.yml 声明的依赖（包/MCP/LSP）并接线到各 runtime
apm compile --clean  # 编译 .apm/ 源 → AGENTS.md 等产物（根 package.json 的 prepare 已包含这两步）
apm targets          # 查看当前启用的 runtime 目标及状态
apm doctor           # 环境诊断
```

## 修改流程

1. 改 `.apm/` 或 `apm.yml`
2. `apm install`，再先运行 `apm compile --clean --dry-run`：若不会删除其他已注册 worktree 的产物，运行 `apm compile --clean`；否则运行不带 `--clean` 的 `apm compile`
3. 检查产物 diff（`AGENTS.md`、`.lsp.json` 等）符合预期后一并提交

## 注意事项

- 当前 targets：`codex`、`claude`（见 `apm.yml`）；新增 runtime 时在 `targets` 追加后重新 install。
- `apm install` 的 policy 警告（org `.github-private` 仓库读不到）不影响安装；若 org 发布 policy 仓库，需给 token 补 `Contents: read` 权限。
- APM 详细用法见官方文档：https://microsoft.github.io/apm/
