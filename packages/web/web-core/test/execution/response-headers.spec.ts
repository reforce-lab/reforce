import { describe, expect, test } from "vitest";
import { ResponseHeaders } from "@/execution/response-headers";

// 响应头载体（#373）：框架内部的响应头通道。它必须与标准 Headers 在框架用到的那几个语义上
// 逐条对齐，否则「省一次物化」就变成了「换一套行为」。

describe("ResponseHeaders name handling", () => {
  test("looks a header up regardless of case", () => {
    const headers = new ResponseHeaders();

    headers.set("Content-Type", "application/json");

    expect(headers.get("content-type")).toBe("application/json");
  });

  test("answers null for a header that was never set", () => {
    expect(new ResponseHeaders().get("x-absent")).toBeNull();
  });

  test("set replaces the previous value", () => {
    const headers = new ResponseHeaders();

    headers.set("x-tag", "one");
    headers.set("x-tag", "two");

    expect(headers.get("x-tag")).toBe("two");
  });

  test("append joins repeated values with a comma", () => {
    const headers = new ResponseHeaders();

    headers.append("x-tag", "one");
    headers.append("x-tag", "two");

    expect(headers.get("x-tag")).toBe("one, two");
  });

  test("delete removes a header", () => {
    const headers = new ResponseHeaders();

    headers.set("x-tag", "one");
    headers.delete("X-Tag");

    expect(headers.has("x-tag")).toBe(false);
  });
});

// set-cookie 是唯一不能并成逗号串的头：逗号串会被浏览器当成一条 cookie。
describe("ResponseHeaders set-cookie", () => {
  test("keeps appended cookies as separate values", () => {
    const headers = new ResponseHeaders();

    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");

    expect(headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  test("set replaces the whole cookie list", () => {
    const headers = new ResponseHeaders();

    headers.append("set-cookie", "a=1");
    headers.set("set-cookie", "b=2");

    expect(headers.getSetCookie()).toEqual(["b=2"]);
  });

  test("answers an empty list when no cookie was written", () => {
    expect(new ResponseHeaders().getSetCookie()).toEqual([]);
  });
});

// 引擎的写出循环直接吃 forEach + getSetCookie，所以这两个的形状必须与标准 Headers 一致。
describe("ResponseHeaders iteration", () => {
  test("visits each header with the value first and the name second", () => {
    const headers = new ResponseHeaders();
    headers.set("content-type", "application/json");
    const seen: [string, string][] = [];

    headers.forEach((value, name) => {
      seen.push([name, value]);
    });

    expect(seen).toEqual([["content-type", "application/json"]]);
  });

  test("visits set-cookie as one comma-joined value, matching Headers.forEach", () => {
    const headers = new ResponseHeaders();
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");
    const seen: string[] = [];

    headers.forEach((value, name) => {
      if (name === "set-cookie") {
        seen.push(value);
      }
    });

    expect(seen).toEqual(["a=1, b=2"]);
  });
});

describe("ResponseHeaders materialization", () => {
  test("carries every written header into the standard Headers", () => {
    const headers = new ResponseHeaders();
    headers.set("content-type", "application/json");
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");

    const standard = headers.standard();

    expect(standard.get("content-type")).toBe("application/json");
    expect(standard.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  test("returns the same Headers instance on every later read", () => {
    const headers = new ResponseHeaders();

    expect(headers.standard()).toBe(headers.standard());
  });

  // 物化之后必须只剩一个真相：框架后写的头要落进用户手里那个 Headers，反之亦然。两个方向
  // 都测——只测一个方向的话，「写进载体但读不到」这类分叉会漏掉一半。
  test("routes writes made after materializing into that same Headers", () => {
    const headers = new ResponseHeaders();
    const standard = headers.standard();

    headers.set("x-request-id", "abc");

    expect(standard.get("x-request-id")).toBe("abc");
  });

  test("sees writes made directly on the materialized Headers", () => {
    const headers = new ResponseHeaders();
    headers.standard().set("x-request-id", "abc");

    expect(headers.get("x-request-id")).toBe("abc");
  });

  test("from() treats an existing Headers as already materialized", () => {
    const standard = new Headers({ "x-tag": "one" });

    const headers = ResponseHeaders.from(standard);

    expect(headers.get("x-tag")).toBe("one");
    expect(headers.standard()).toBe(standard);
  });
});
