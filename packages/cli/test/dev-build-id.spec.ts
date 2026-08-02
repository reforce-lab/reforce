import { expect, test } from "bun:test";
import { createDevBuildId, type DevBuildAsset } from "@/dev-build-id";

const encoder = new TextEncoder();

function asset(path: string, content: string, role: DevBuildAsset["role"]): DevBuildAsset {
  return { path, role, bytes: encoder.encode(content) };
}

test("a nonempty Rspack hash is the preferred build identity", () => {
  const id = createDevBuildId({
    statsHash: "abc123",
    assets: [],
  });

  expect(id).toBe("rspack:abc123");
});

test("fallback identity is stable across asset traversal order", () => {
  const main = asset("main.mjs", "main", "entry");
  const chunk = asset("chunks/service.mjs", "chunk", "chunk");

  const forward = createDevBuildId({ assets: [main, chunk] });
  const reverse = createDevBuildId({ assets: [chunk, main] });

  expect(forward).toBe(reverse);
  expect(forward).toMatch(/^sha256:[a-f0-9]{64}$/u);
});

test("source maps and hot updates do not alter fallback identity", () => {
  const runtime = [
    asset("main.mjs", "main", "entry"),
    asset("chunks/service.mjs", "chunk", "chunk"),
  ];
  const baseline = createDevBuildId({ assets: runtime });

  const withTransientAssets = createDevBuildId({
    assets: [
      ...runtime,
      asset("main.mjs.map", "map", "source-map"),
      asset("main.123.hot-update.mjs", "hot", "hot-update"),
    ],
  });

  expect(withTransientAssets).toBe(baseline);
});

test("fallback identity changes with runtime bytes", () => {
  const first = createDevBuildId({
    assets: [asset("main.mjs", "first", "entry")],
  });
  const second = createDevBuildId({
    assets: [asset("main.mjs", "second", "entry")],
  });

  expect(second).not.toBe(first);
});
