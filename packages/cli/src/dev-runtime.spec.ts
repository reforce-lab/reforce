import { expect, test } from "bun:test";
import type { RspackHmrRuntime } from "./dev-hmr-manager";
import { createRspackHmrRuntime } from "./dev-runtime";

function rejectingRuntime(error: unknown): RspackHmrRuntime {
  return {
    accept() {},
    async check() {
      throw error;
    },
    async apply() {},
  };
}

test("a missing Rspack update manifest is an empty HMR polling round", async () => {
  const error = Object.assign(new Error("missing update manifest"), {
    code: "ERR_MODULE_NOT_FOUND",
    url: "file:///project/.reforce/dev/updates/main.abc.hot-update.json",
  });
  const runtime = createRspackHmrRuntime(rejectingRuntime(error));

  const result = await runtime.check(false);

  expect(result).toBeNull();
});

test("a Bun missing-module error for an update manifest is an empty HMR polling round", async () => {
  const error = {
    message:
      "Cannot find module './updates/main.abc.hot-update.json' from '/project/.reforce/dev/main.mjs'",
  };
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
