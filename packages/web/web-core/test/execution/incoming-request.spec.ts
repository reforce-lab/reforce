import { describe, expect, test } from "vitest";
import { fromStandardRequest, type IncomingRequest } from "@/execution/incoming-request";
import { RequestContextState } from "@/execution/request-context";
import { metaLookup } from "@/routing/route-marker";

// IncomingRequest（#341）：引擎交给核心的每请求入口。核心热路径上只用 method / url() /
// header() 三样，标准 Request 只在用户读 context.request 时才造。

// 计数替身：物化与解析都是"发生了就是发生了"的副作用，只能靠计数观察——惰性是本 issue 的
// 全部收益，没有它这一层就只是多绕了一道。
function countingIncoming(url: string): IncomingRequest & {
  readonly counts: { standard: number; url: number };
} {
  const counts = { standard: 0, url: 0 };
  let parsed: URL | undefined;
  let request: Request | undefined;
  return {
    counts,
    method: "GET",
    url: () => {
      counts.url += 1;
      parsed ??= new URL(url);
      return parsed;
    },
    header: () => null,
    standard: () => {
      counts.standard += 1;
      request ??= new Request(url);
      return request;
    },
  };
}

function contextOf(incoming: IncomingRequest): RequestContextState {
  return new RequestContextState({
    incoming,
    method: "GET",
    path: "/users/:id",
    params: { id: "1" },
    meta: metaLookup({}),
  });
}

describe("RequestContextState laziness", () => {
  test("never materializes the standard Request when nobody reads context.request", () => {
    const incoming = countingIncoming("https://reforce.test/users/1?limit=10");
    const context = contextOf(incoming);

    // url / query / params / meta 是请求日志与中间件真正会碰的东西，全都不该逼出 Request
    expect(context.url.pathname).toBe("/users/1");
    expect(context.query).toEqual({ limit: "10" });
    expect(context.params).toEqual({ id: "1" });

    expect(incoming.counts.standard).toBe(0);
  });

  test("asks the engine for the URL once no matter how many times it is read", () => {
    const incoming = countingIncoming("https://reforce.test/users/1?limit=10");
    const context = contextOf(incoming);

    const first = context.url;
    const second = context.url;
    context.query;

    expect(second).toBe(first);
    expect(incoming.counts.url).toBe(1);
  });

  test("hands back whatever the engine materialized, unchanged", () => {
    const incoming = countingIncoming("https://reforce.test/users/1");
    const context = contextOf(incoming);

    expect(context.request).toBe(incoming.standard());
  });
});

describe("fromStandardRequest", () => {
  test("reads a header through the standard Headers, case-insensitively", () => {
    const incoming = fromStandardRequest(
      new Request("https://reforce.test/", { headers: { "x-probe": "seen" } }),
    );

    expect(incoming.header("X-Probe")).toBe("seen");
  });

  test("answers null for a header that was not sent", () => {
    const incoming = fromStandardRequest(new Request("https://reforce.test/"));

    expect(incoming.header("x-absent")).toBeNull();
  });

  test("parses the URL once and returns the same instance", () => {
    const incoming = fromStandardRequest(new Request("https://reforce.test/users?q=1"));

    expect(incoming.url()).toBe(incoming.url());
    expect(incoming.url().searchParams.get("q")).toBe("1");
  });

  // 缓存是硬约束而不是优化：两个 Request 包着同一条体流，读第二次直接 body unusable。
  test("returns the very Request it was given, every time", () => {
    const request = new Request("https://reforce.test/");
    const incoming = fromStandardRequest(request);

    expect(incoming.standard()).toBe(request);
    expect(incoming.standard()).toBe(request);
  });

  test("carries the method across", () => {
    const incoming = fromStandardRequest(new Request("https://reforce.test/", { method: "POST" }));

    expect(incoming.method).toBe("POST");
  });
});
