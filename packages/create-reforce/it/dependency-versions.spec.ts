import { describe, expect, test } from "vitest";
import { DEPENDENCY_VERSIONS, DEV_DEPENDENCY_VERSIONS } from "@/dependency-versions";

// 模板依赖"保持最新"在这里变成可执行的断言，而不是一句承诺。默认不跑：CI 与离线开发
// 不该因为上游发了个 patch 就变红，而且这是唯一需要外网的用例。
// 手动核对：REFORCE_CHECK_LATEST=1 pnpm run test --filter=create-reforce
const enabled = process.env.REFORCE_CHECK_LATEST === "1";

const PINNED = { ...DEPENDENCY_VERSIONS, ...DEV_DEPENDENCY_VERSIONS };

async function latestVersionOf(packageName: string): Promise<string> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
  );
  if (!response.ok) {
    throw new Error(`registry 返回 ${response.status}：${packageName}`);
  }
  const payload: unknown = await response.json();
  if (
    typeof payload === "object" &&
    payload !== null &&
    "version" in payload &&
    typeof payload.version === "string"
  ) {
    return payload.version;
  }
  throw new Error(`registry 响应里没有 version 字段：${packageName}`);
}

describe.runIf(enabled)("模板依赖版本", () => {
  test.each(Object.entries(PINNED))("%s 钉的是 registry 上的 latest", async (name, pinned) => {
    const latest = await latestVersionOf(name);

    expect(pinned).toBe(`^${latest}`);
  });
});

describe.skipIf(enabled)("模板依赖版本（未联网核对）", () => {
  test("版本号形态是 caret range，锁死写法便于联网用例比对", () => {
    for (const [name, pinned] of Object.entries(PINNED)) {
      expect(pinned, `${name} 应写成 ^x.y.z`).toMatch(/^\^\d+\.\d+\.\d+$/);
    }
  });
});
