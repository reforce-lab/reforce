import { expect, test } from "vitest";
import { createRspackHmrRuntime } from "@/dev-runtime";
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
