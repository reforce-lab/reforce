<!--
PR 规则：必须链接 Issue；标题遵循 Conventional Commits（会进 squash 提交历史）。
-->

## 关联

Closes #<!-- issue 编号 -->

## 变更内容

<!-- 做了什么，一两段话说清 -->

## 为什么这么做

<!-- 如果涉及取舍，给出理由；引用外部事实请注明来源与核实日期 -->

## 验证

- [ ] `pnpm run check:write` 通过
- [ ] `pnpm run typecheck` 通过
- [ ] `pnpm run test` 通过（新增逻辑带测试）
- [ ] `pnpm run build` 通过
- [ ] 涉及架构决策 → 已在关联 issue 顶楼更新结论
- [ ] 值得长期查阅的结论 → 已更新 Wiki

## 备注

<!-- reviewer 需要知道的上下文 -->
