import { describe, expect, test } from "vitest";
import { requestIdHeader, resolveRequestId } from "@/execution/request-id";

// request id 解析(#303):合法客户端值回显,其余一律重新生成——头值完全由客户端控制,
// 回显闸是日志与响应头的注入防线。

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requestWith(id?: string): Request {
  return new Request("https://reforce.test/", {
    headers: id === undefined ? {} : { [requestIdHeader]: id },
  });
}

describe("resolveRequestId", () => {
  test("echoes a legal client-provided id", () => {
    expect(resolveRequestId(requestWith("trace-abc.123"))).toBe("trace-abc.123");
  });

  test("generates a UUID when the header is absent", () => {
    expect(resolveRequestId(requestWith())).toMatch(uuidPattern);
  });

  test("regenerates when the value is too long or carries illegal characters", () => {
    const tooLong = "a".repeat(129);
    for (const bad of [tooLong, "has space", ""]) {
      const resolved = resolveRequestId(requestWith(bad));
      expect(resolved).not.toBe(bad);
      expect(resolved).toMatch(uuidPattern);
    }
  });

  test("two generated ids differ", () => {
    expect(resolveRequestId(requestWith())).not.toBe(resolveRequestId(requestWith()));
  });
});
