# 贡献指南

## 一切从 Issue 开始

- 任何改动（功能、修复、调研）都应该有对应的 Issue；PR 必须链接 Issue（`Closes #n`）。
- 设计类问题走 **[RFC] Issue 模板**；结论被接受后直接编辑到该 issue 顶楼，打 `type: adr` 标签，并登记 Wiki 的 ADR 索引。
- 不确定该不该做？先开 Issue 讨论，不要先写代码。

## 分支与提交

- 分支：`feat/<issue>-<slug>`、`fix/<issue>-<slug>`、`chore/<slug>`。
- 提交信息遵循 **Conventional Commits**（commitlint 强制）：
  - `feat(core): add bean definition registry`
  - `fix(compiler): preserve canonical project identity`
  - `feat(cli): add production reader lease`
  - `chore(tooling): bump typescript to 7.0.2`
  - `docs(adr): record decorator strategy decision`
- scope 使用实际包或领域名（如 `context` / `compiler` / `cli` / `tooling`）。

## 本地检查（提交前会自动跑）

lefthook 在 `pre-commit` 跑 Biome 自动修复，在 `commit-msg` 跑 commitlint。
受影响 package 先分别运行以下命令：

```bash
bun run check:write --filter=<package>
bun run check --filter=<package>
bun run typecheck --filter=<package>
bun run test --filter=<package>
bun run build --filter=<package>
```

提交前再运行全仓门禁：

```bash
bun run check:write
bun run check
bun run typecheck
bun run test
bun run build
```

有 JS 产物的 package 统一使用 Rslib：SWC 生成 Bun 可执行的服务端 ESM，TSGo 生成 bundled d.ts，`@swc/helpers` 作为声明过的运行时依赖复用 helper。`bun run typecheck` 仍是独立的 TSGo no-emit 校验。源码内部 import 写相对路径且不带扩展名；只有 Compiler 写入应用 production output 的相对 module specifier 使用 `.js`。

CI 在 `ubuntu-latest`、`macos-latest`、`windows-latest` 使用 Bun 1.3.14 执行 frozen install、`check` / `typecheck` / `test` / `build`、真实 CLI/child/HMR/lease/transaction recovery 和 production artifact smoke。`check:write` 只用于提交前修复，CI 不重复执行与 `check` 等价的写入再比较。平台相关行为必须由对应 runner 的真实 Bun 进程证据支持。

Compiler 只维护 Yuku frontend。Adapter 测试直接断言 Source IR、span 与 parser diagnostic 的相关字段；完整项目行为由 Compiler 集成测试和生成物执行测试负责，不提交整棵 Source IR 或 generated output 快照。

## 运行一个应用

应用使用仓库唯一的共享 TypeScript 配置。它关闭旧 decorators 与 runtime metadata，只保留标准 decorators：

```json
{
  "extends": "@reforce/tooling-tsconfig/base.json",
  "include": ["src", ".reforce/generated/**/*.d.ts"]
}
```

```ts
import { Injectable, type OnContextClose, type OnContextStart } from "@reforce/context";

@Injectable()
export class Application implements OnContextStart, OnContextClose {
  onContextStart(): void {}
  onContextClose(): void {}
}
```

standalone 项目在自身目录运行；monorepo 可以从根目录选择 leaf application：

```bash
reforce dev --project .
reforce build --project apps/api
reforce build --project . --tsconfig apps/api/tsconfig.json
reforce start --project apps/api
```

`--tsconfig` 相对 `--project` 解析。最终 project root 始终是 leaf tsconfig 所在目录；`generated`、`dev` 与 `dist` 输出不会写到 monorepo 根或 sibling app。

## 知识沉淀义务

- 做了影响后续设计的决定 → 在对应 issue 顶楼记录结论（**顶楼 = 正式文档，评论 = 过程**），打 `type: adr` 标签并登记 Wiki ADR 索引。
- 结论值得长期查阅 → 更新 Wiki 对应页面（Wiki 直接在 GitHub 编辑，不落代码仓库）。
- 只在 PR 描述里写"为什么这么改"是不够的，PR 会沉没，Issue / Wiki 不会。
