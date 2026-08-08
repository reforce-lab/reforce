import { describe, expect, test } from "vitest";
import { acceptHost, requestUrl } from "@/request";

// 与 web-node 的 requestUrl 同一段逻辑、同一个理由（#226）：请求目标是请求方完全控制的
// 字符串，authority 只能来自 Host 头。这里逐条钉住，免得两个引擎在这条安全面上走散。

function urlOf(target: string, host = "localhost:3000"): URL | undefined {
  return requestUrl({ headers: { host }, url: target });
}

describe("requestUrl", () => {
  test("takes the authority from the Host header", () => {
    expect(urlOf("/users/42")?.host).toBe("localhost:3000");
  });

  test("keeps the path and query", () => {
    const url = urlOf("/users/42?limit=10&limit=20");

    expect(url?.pathname).toBe("/users/42");
    expect(url?.search).toBe("?limit=10&limit=20");
  });

  // `//evil.com/health` 在 WHATWG URL 解析下是 protocol-relative 引用：new URL(target, base)
  // 会把 host 换成 evil.com，handler 拿 url.origin 拼跳转即开放重定向。
  test("does not let a protocol-relative target move the host", () => {
    const url = urlOf("//evil.com/health");

    expect(url?.host).toBe("localhost:3000");
    expect(url?.pathname).toBe("//evil.com/health");
  });

  test("does not let an absolute-form target move the host", () => {
    expect(urlOf("http://evil.com/health")?.host).toBe("localhost:3000");
  });

  test("preserves %2F in the path so the segment structure survives", () => {
    expect(urlOf("/users/a%2Fb")?.pathname).toBe("/users/a%2Fb");
  });

  // 畸形 Host 会让 new URL 抛 TypeError；调用方据此出 400
  test("rejects a malformed Host header", () => {
    expect(urlOf("/users/42", "a b")).toBeUndefined();
  });

  // 带凭据的 Host 通过 new URL，但 Fetch 规范要求 new Request 抛——同一道 guard 一起挡掉
  test("rejects a Host header carrying userinfo", () => {
    expect(urlOf("/users/42", "user@evil.com")).toBeUndefined();
    expect(urlOf("/users/42", "user:pw@evil.com")).toBeUndefined();
  });

  test("rejects an empty Host header", () => {
    expect(urlOf("/users/42", "")).toBeUndefined();
  });

  test("falls back to a root path when the target is absent", () => {
    expect(requestUrl({ headers: { host: "localhost:3000" } })?.pathname).toBe("/");
  });
});

// Host 校验带一格缓存（#373）：同值重复时降到 2.4 纳秒，但缓存就是新的失效风险——
// 下面四条钉的正是"换了 Host 之后判定必须跟着换"，两个方向都要。
describe("acceptHost", () => {
  test("returns the host when it can serve as the request authority", () => {
    expect(acceptHost({ headers: { host: "localhost:3000" } })).toBe("localhost:3000");
  });

  test("falls back to localhost when the Host header is absent", () => {
    expect(acceptHost({ headers: {} })).toBe("localhost");
  });

  test("re-evaluates when a malformed host follows an accepted one", () => {
    acceptHost({ headers: { host: "localhost:3000" } });

    expect(acceptHost({ headers: { host: "a b" } })).toBeUndefined();
  });

  test("re-evaluates when an acceptable host follows a rejected one", () => {
    acceptHost({ headers: { host: "a b" } });

    expect(acceptHost({ headers: { host: "localhost:3000" } })).toBe("localhost:3000");
  });

  test("rejects a host carrying userinfo even right after accepting a clean one", () => {
    acceptHost({ headers: { host: "localhost:3000" } });

    expect(acceptHost({ headers: { host: "user@evil.com" } })).toBeUndefined();
  });
});
