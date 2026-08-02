---
description: Reforce 仓库级 E2E 的公开入口、dist 与进程清理规则
applyTo: "e2e/**"
---

- E2E 只从构建后的公开 CLI/dist 进入，不直接调用 Compiler 内部 API。
- E2E 测试复制 `e2e/fixtures/application` 后再生成或修改；禁止污染原始模板。场景差异只修改临时副本中的最小文件或值，不在 spec 中参数化生成第二套完整应用。
- 子进程和 Worker 必须设置超时，并在 `finally`/suite cleanup 中回收，即使断言失败也不能遗留进程。
- `e2e/support` 只服务 E2E，不允许包级 Unit/IT 反向依赖。
- `bun run test` 只运行包级 Unit/IT；完整用户链路使用独立的 `bun run test:e2e`。
- 关键链路覆盖 dev/build/start、dist-only dependency、leaf tsconfig/monorepo selection 和 Worker isolation。
