# 贡献指南

## 一切从 Issue 开始

- 任何改动（功能、修复、调研）都应该有对应的 Issue；PR 必须链接 Issue（`Closes #n`）。
- 设计类问题走 **[RFC] Issue 模板**；结论被接受后直接编辑到该 issue 顶楼，打 `type: adr` 标签，并登记 Wiki 的 ADR 索引。
- 不确定该不该做？先开 Issue 讨论，不要先写代码。

## 分支与提交

- 分支：`feat/<issue>-<slug>`、`fix/<issue>-<slug>`、`chore/<slug>`。
- 提交信息遵循 **Conventional Commits**（commitlint 强制）：
  - `feat(core): add bean definition registry`
  - `fix(playground): correct bun types resolution`
  - `chore(tooling): bump typescript to 7.0.2`
  - `docs(adr): record decorator strategy decision`
- scope 使用包名（`core` / `playground` / `tooling`）或领域名。

## 本地检查（提交前会自动跑）

lefthook 在 `pre-commit` 跑 Biome 自动修复，在 `commit-msg` 跑 commitlint。
完整验证请手动跑一遍（CI 也会跑）：

```bash
bun run check:write && bun run typecheck && bun run test && bun run build
```

## 知识沉淀义务

- 做了影响后续设计的决定 → 在对应 issue 顶楼记录结论（**顶楼 = 正式文档，评论 = 过程**），打 `type: adr` 标签并登记 Wiki ADR 索引。
- 结论值得长期查阅 → 更新 Wiki 对应页面（Wiki 直接在 GitHub 编辑，不落代码仓库）。
- 只在 PR 描述里写"为什么这么改"是不够的，PR 会沉没，Issue / Wiki 不会。
