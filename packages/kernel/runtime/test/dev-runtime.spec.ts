import { afterEach, expect, test, vi } from "vitest";
import { createRspackHmrRuntime, enableDevErrorPage } from "@/dev-runtime";
import type { RspackHmrRuntime } from "@/hmr-manager";

function rejectingRuntime(error: unknown): RspackHmrRuntime {
  return {
    async check() {
      throw error;
    },
    async apply() {},
  };
}

test("a missing Rspack update manifest is a no-op HMR check", async () => {
  const error = Object.assign(new Error("missing update manifest"), {
    code: "ERR_MODULE_NOT_FOUND",
    url: "file:///project/.reforce/dev/updates/main.abc.hot-update-manifest.mjs",
  });
  const runtime = createRspackHmrRuntime(rejectingRuntime(error));

  const result = await runtime.check(false);

  expect(result).toBeNull();
});

test("a missing manifest reported by path is also a no-op HMR check", async () => {
  const error = Object.assign(new Error("missing update manifest"), {
    code: "ENOENT",
    path: "/project/.reforce/dev/updates/main.abc.hot-update-manifest.mjs",
  });
  const runtime = createRspackHmrRuntime(rejectingRuntime(error));

  const result = await runtime.check(false);

  expect(result).toBeNull();
});

test("an unrelated HMR check error remains fatal", async () => {
  const error = Object.assign(new Error("missing application module"), {
    code: "ERR_MODULE_NOT_FOUND",
    url: "file:///project/src/missing.mjs",
  });
  const runtime = createRspackHmrRuntime(rejectingRuntime(error));

  const result = runtime.check(false);

  await expect(result).rejects.toBe(error);
});

// —— dev 错误页旗标（#279）——
// 键字面量与 @reforce/web-core 错误分派的读取侧一致；这三条钉住「设置侧」的全部分支。

const devErrorPageFlag = Symbol.for("reforce.devErrorPage");

afterEach(() => {
  Reflect.deleteProperty(globalThis, devErrorPageFlag);
  vi.unstubAllEnvs();
});

test("enableDevErrorPage raises the global flag", () => {
  enableDevErrorPage();

  expect(Reflect.get(globalThis, devErrorPageFlag)).toBe(true);
});

test("REFORCE_DEV_ERROR_PAGE=off keeps the flag unset", () => {
  vi.stubEnv("REFORCE_DEV_ERROR_PAGE", "off");

  enableDevErrorPage();

  expect(Reflect.get(globalThis, devErrorPageFlag)).toBeUndefined();
});

// 逃生门只认 "off" 一个值：拼错值静默把带栈的页面留在 LAN 上，比「开着」更危险的是
// 「以为关了」。这里钉住非 off 值不关门，文档教用户用 off。
test("an unrelated REFORCE_DEV_ERROR_PAGE value still raises the flag", () => {
  vi.stubEnv("REFORCE_DEV_ERROR_PAGE", "false");

  enableDevErrorPage();

  expect(Reflect.get(globalThis, devErrorPageFlag)).toBe(true);
});
