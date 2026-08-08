import { describe, expect, test } from "vitest";
import { webEngineAddress, webEngineHostname } from "@/adapter";

// 监听主机名的单一事实源（#323）。此前三个引擎各自省略 host 参数吃底层缺省，而底层缺省
// 互相矛盾：node/hono 绑全接口、fastify 绑 localhost，同一份应用换引擎就换了暴露面。
describe("the shared listen hostname", () => {
  test("falls back to localhost when the application configured none", () => {
    expect(webEngineHostname(undefined)).toBe("localhost");
  });

  // 显式值一律照办，包括把服务开到全世界的那两个——收紧的是缺省，不是用户的决定权。
  for (const configured of ["0.0.0.0", "::", "127.0.0.1", "example.internal"]) {
    test(`passes the configured hostname ${configured} through untouched`, () => {
      expect(webEngineHostname(configured)).toBe(configured);
    });
  }
});

describe("the shared engine address", () => {
  test("reports the hostname the engine actually listens on", () => {
    expect(webEngineAddress({ hostname: "127.0.0.1", port: 8080 })).toStrictEqual({
      hostname: "127.0.0.1",
      port: 8080,
      url: "http://127.0.0.1:8080/",
    });
  });

  // 启动摘要那一行是给人点的，e2e 也从里面抠 URL 做就绪探测，所以通配地址不能原样拼进去。
  for (const wildcard of ["0.0.0.0", "::"]) {
    test(`renders the wildcard hostname ${wildcard} as a reachable localhost URL`, () => {
      expect(webEngineAddress({ hostname: wildcard, port: 3000 }).url).toBe(
        "http://localhost:3000/",
      );
    });
  }

  // 裸 IPv6 拼进 authority 会得到畸形的 http://::1:3000/——冒号是端口分隔符，必须加方括号。
  test("brackets an IPv6 literal so the URL stays parseable", () => {
    const address = webEngineAddress({ hostname: "::1", port: 3000 });

    expect(address.url).toBe("http://[::1]:3000/");
    expect(new URL(address.url).port).toBe("3000");
  });

  test("keeps the wildcard hostname itself as the listening fact", () => {
    expect(webEngineAddress({ hostname: "0.0.0.0", port: 3000 }).hostname).toBe("0.0.0.0");
  });
});
