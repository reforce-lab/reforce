import { expect, test } from "bun:test";
import { realpathSync, statSync } from "node:fs";

import { resolveRuntimeEntryPath } from "@/bundling/runtime-locator";

// 定位语义（ADR 0009，#191）：目标经 @reforce/runtime 的 exports 解析、返回真实路径且文件
// 必须存在——三条不变量分别兜住替换目标漂移、symlink 进 rspack 模块图（#180）与"失败发生在
// build 启动前"。依赖 turbo ^build 先产出 @reforce/runtime dist。

test("resolves the dev runtime entry to an existing real path", () => {
  const entryPath = resolveRuntimeEntryPath("dev-runtime");

  expect(entryPath.endsWith("dev-runtime.js")).toBe(true);
  expect(entryPath).toBe(realpathSync(entryPath));
  expect(statSync(entryPath).isFile()).toBe(true);
});

test("resolves the production runtime entry to an existing real path", () => {
  const entryPath = resolveRuntimeEntryPath("production-runtime");

  expect(entryPath.endsWith("production-runtime.js")).toBe(true);
  expect(entryPath).toBe(realpathSync(entryPath));
  expect(statSync(entryPath).isFile()).toBe(true);
});
