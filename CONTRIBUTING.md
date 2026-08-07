# 贡献指南

## 一切从 Issue 开始

- 任何改动（功能、修复、调研）都应该有对应的 Issue；PR 必须链接 Issue（`Closes #n`）。
- 设计类问题走 **[RFC] Issue 模板**；结论被接受后直接编辑到该 issue 顶楼，打 `type: adr` 标签，并登记 Wiki 的 ADR 索引。
- 不确定该不该做？先开 Issue 讨论，不要先写代码。

## Issue 标题

事务型 Issue（会落到某个包或领域的具体改动）用和 commit 同一套词汇：

```
type(scope): 描述
```

- `type` 取 Conventional Commits 的类型，且与该 Issue **最终要做的动作**一致，而不是与它的表象一致。
  例：「某条 IT 在 macOS 上假失败」要做的是改测试断言，写 `test(cli):` 而不是 `fix(cli):`；
  「上游有缺陷，我们先加本地补偿」写 `chore(<pkg>):`。
- `scope` 不得为空，取实际包或领域名（仓库在用的：`context` / `compiler` / `cli` / `packages` / `tooling` / `ci` / `repo`）。
- 描述写**已核实的事实和后果**，不写猜测。多个后果用破折号或逗号接在一句里，不为了短而丢掉判断依据。

没有单一 scope 的元 Issue 保留方括号前缀，不套 `type(scope)`：

| 前缀 | 用途 |
|---|---|
| `[EPIC] ` | 跨多个包、需要拆子 Issue 的长期主题 |
| `[RFC] ` | 设计提案；结论被接受后标题改为 `[ADR] 000N · <决策>`，标签改 `type: adr` |
| `[调研] ` | 结论是一份判断而非一次代码改动的调查 |

> 模板里的 `title` 预填**只对网页表单生效**。`gh issue create --title` 走 API，会完全绕过模板
> （`blank_issues_enabled: false` 同样只挡网页空白 Issue）。本仓库的 Issue 基本都由 CLI 创建，
> 所以标题合规目前没有机械兜底，靠本节约束（Issue #97）。

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
pnpm run check:write --filter=<package>
pnpm run check --filter=<package>
pnpm run typecheck --filter=<package>
pnpm run test --filter=<package>
pnpm run build --filter=<package>
```

提交前再运行全仓门禁：

```bash
pnpm run check:write
pnpm run check
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run test:e2e
```

每个 Rslib workspace 的根 `tsconfig.json` 只包含 `src`，根 `tsconfig.node.json` 包含源码和 Rslib/tooling 配置；测试存在时，由 `test/tsconfig.json` 或 `it/tsconfig.json` 管理。所有配置保持 `noEmit: true`，不使用 project references 或 `tsconfig.build.json`。Rslib 自动读取源码配置：SWC 生成 Node.js 可执行的服务端 ESM，TSGo 生成 d.ts；两者都是 bundleless（所有 lib 条目设 `bundle: false`），`dist/` 与 `src/` 1:1 对应，公开入口落在 `dist/` 根、内部模块落在 `dist/<domain>/`。package 内指向自身 `src` 的 import 统一写成 `@/...`，跨 package 使用 `@reforce/*`；只有 Compiler 写入应用 production output 的相对 module specifier 使用 `.js`。类私有成员使用 TypeScript `private` / `private readonly`，不使用 ES `#field` / `#method` 语法。

单元测试放 `test/`，并严格镜像被测源码路径（如 `src/parser/a.ts` 对应 `test/parser/a.spec.ts`）；跨模块、filesystem、子进程或 Worker 行为放 `it/`。包内不创建 fixture，IT 所需项目树和 harness 在测试 support 中构造。默认 `pnpm run test` 运行 unit 与 IT，完整 dist-only 用户链路单独运行 `pnpm run test:e2e`。

package exports 只公开 `dist`，仓库测试的跨 package import 由 Turbo 先构建上游依赖后消费产物，不设置仓库专用 export condition。Rsbuild 的 `development` / `production` mode 只控制用户应用行为，两种 mode 都必须消费 Reforce package 的 `dist`。

CI 在 `ubuntu-latest`、`macos-latest`、`windows-latest` 使用 Node.js 26 执行 frozen install、`check` / `typecheck` / `test` / `build`、真实 CLI/child/HMR/lease/transaction recovery 和 production artifact smoke。`check:write` 只用于提交前修复，CI 不重复执行与 `check` 等价的写入再比较。平台相关行为必须由对应 runner 的真实 Node.js 进程证据支持。

Compiler 内置唯一的 Yuku parser。Parser-to-IR 测试只断言 Source IR、span 与 parser diagnostic 的必要字段；完整项目行为由 Compiler 集成测试和生成物执行测试负责，不提交整棵 Source IR 或 generated output 快照。

## 运行一个应用

应用使用仓库唯一的共享 TypeScript 配置。它关闭旧 decorators 与 runtime metadata，只保留标准 decorators：

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
import { Injectable, type OnContextClose, type OnContextStart } from "@reforce/core";

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

完整正向应用场景只使用 `e2e/fixtures/application`。它不是独立 workspace，由 `@reforce/e2e` 提供依赖和检查；测试先复制项目输入到临时目录再生成、修改或启动，禁止直接污染模板。

## 错误码（ADR 0013，#280）

**公开契约。** 错误码是公开接口，它进过 `--error-format json` 的 wire 输出（ADR 0009）、`--diagnostic-level <CODE>=off`、`// reforce-ignore <CODE>` 注释，还有用户按 `code` 分派的代码。因此：

- **code 永久稳定。改一个已发布的码 = semver major。** 这条原样采纳 Node.js core 的做法，理由也一样：不这么切，每次改错误文案都要按 breaking change 发版。
- **`message` 与 `help` 可以随任何版本改。** 它们是给人读的散文，不是接口。
- **程序化识别一律用 `code`，不匹配 `message`。** 文档、示例和模板都必须示范这一条。

**码表在哪。** 每个持有码的包都把自己的表声明在 **`src/error-codes.ts`**——**只此一处，不散在 `errors.ts` / `api.ts` / `reporter.ts` 里**。表以 `as const` 数组为唯一真相、union 从数组派生（中央注册包会造成反向依赖）：

| 域 | 表 |
|---|---|
| compiler 诊断 | `packages/compiler/src/error-codes.ts` → `compilerDiagnosticCodes` |
| 容器 | `packages/core/src/error-codes.ts` → `coreErrorCodes` |
| 事务 | `packages/transaction/src/error-codes.ts` → `transactionErrorCodes` |
| web | `packages/web/src/error-codes.ts` → `webErrorCodes` |
| runtime / CLI 失败码 | `packages/runtime/src/error-codes.ts` → `cliFailureCodes` |
| CLI 错误码 | `packages/cli/src/error-codes.ts` → `cliErrorCodes`（前者的子集） |

`packages/cli/src/explain/code-registry.ts` 把它们聚合到一起，`packages/cli/test/explain/code-registry.spec.ts` 断言全局唯一。**新增一个持有码的包，就建它的 `src/error-codes.ts` 并在 registry 里登记一行**，否则它不参与查重。

**新增码的纪律。**

- **新码带域前缀**：`CORE_` / `CONFIG_` / `WEB_` / `CLI_` / `TRANSACTION_`。compiler 诊断码维持无前缀惯例——它们有独立闭集与独立消费面（抑制注释、诊断级别）。
- **存量码一律不改名。** 改码会砸掉用户已经写下的 `--diagnostic-level`、`// reforce-ignore` 注释和 json 消费方。
- **长文与码同 PR**：新增任何错误码，`packages/cli/src/explain/` 的对应长文表（compiler 诊断在 `codes.ts`，其余按读者场景分表）里同时补上它的长文。这条由 `packages/cli/test/explain/codes.spec.ts` 的全量覆盖断言机械化（#297 收口后全部存量码已有长文）：漏写长文的码会被点名，测试通不过。
- **不是所有失败都要码。** 纯包内的控制流信号（不会越过框架边界抵达用户的那种）维持裸 `Error`，不进码表。

## 知识沉淀义务

- 做了影响后续设计的决定 → 在对应 issue 顶楼记录结论（**顶楼 = 正式文档，评论 = 过程**），打 `type: adr` 标签并登记 Wiki ADR 索引。
- 结论值得长期查阅 → 更新 Wiki 对应页面（Wiki 直接在 GitHub 编辑，不落代码仓库）。
- 只在 PR 描述里写"为什么这么改"是不够的，PR 会沉没，Issue / Wiki 不会。
