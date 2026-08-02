---
description: 唯一 E2E application 模板的用户项目边界
applyTo: "e2e/fixtures/application/**"
---

- `e2e/fixtures/application` 是唯一完整应用模板，不是 workspace；依赖由父级 `@reforce/e2e` workspace 提供，不支持脱离仓库单独安装。
- 按真实用户项目编写，只使用公开 `@reforce/*` API；应用内部 `src` import 使用 `@/*`。
- 禁止引用仓库内部路径、测试 support 或 Compiler 内部 API。
- 不提交 `node_modules`、`.reforce` 或 `dist`；自动化测试必须复制模板后再生成、修改或启动。
