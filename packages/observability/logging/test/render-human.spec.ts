import { Writable } from "node:stream";
import type { LogRecord } from "@reforce/logging-contracts";
import { describe, expect, test } from "vitest";
import { createHumanRenderer } from "@/render-human";

// human 档（RFC 0011 D2，#242）：级别词 + 对齐的 logger 名 + 消息 + key=value 字段 +
// 相对时间戳；err 走栈折叠与竖排 cause 链。颜色按流判定，这里的假流不是 TTY，所以输出
// 不带 ANSI——上色与降级由 e2e 的真 pty 用例覆盖。

function sink(): Writable {
  return new Writable({ write: (_chunk, _encoding, callback) => callback() });
}

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    level: "info",
    name: "OrderService",
    time: 1_700_000_000_000,
    message: "order placed",
    fields: {},
    ...overrides,
  };
}

describe("human rendering", () => {
  test("aligns the level word and the logger name into stable columns", () => {
    const render = createHumanRenderer({ stream: sink() });

    const line = render(record());

    expect(line).toContain("  info OrderService");
    // 名字列定宽：消息的起点不随名字长短漂移。
    expect(line).toMatch(/OrderService {6} order placed/u);
  });

  test("keeps the distinguishing tail of an over-wide logger name", () => {
    const render = createHumanRenderer({ stream: sink() });

    const line = render(record({ name: "services.orders.OrderService" }));

    expect(line).toContain("…ders.OrderService");
    expect(line).not.toContain("services.orders.");
  });

  test("renders fields as key=value pairs after the message", () => {
    const render = createHumanRenderer({ stream: sink() });

    const line = render(record({ fields: { orderId: 1042, state: "open" } }));

    expect(line).toContain("orderId=1042 state=open");
  });

  // 相对时间戳（+12ms）是与上一条记录的间隔：dev 下读者关心「这两步之间过了多久」，
  // 完整时刻表归 JSON 模式。
  test("stamps the interval since the previous record, starting at zero", () => {
    const render = createHumanRenderer({ stream: sink() });

    const first = render(record({ time: 1_000 }));
    const second = render(record({ time: 1_012 }));

    expect(first).toContain("+0ms");
    expect(second).toContain("+12ms");
  });

  test("folds node internals out of an err stack", () => {
    const render = createHumanRenderer({ stream: sink() });
    const error = new Error("boom");
    error.stack = [
      "Error: boom",
      "    at place (/app/src/order.ts:10:5)",
      "    at node:internal/modules/run_main:1:1",
      "    at node:internal/process/task_queues:2:2",
    ].join("\n");

    const lines = render(record({ level: "error", fields: { err: error } })).split("\n");

    expect(lines[1]).toContain("Error: boom");
    expect(lines[2]).toContain("at place (/app/src/order.ts:10:5)");
    expect(lines[3]).toContain("… 2 frames in node/reforce (--verbose to show)");
  });

  test("lays the cause chain out vertically down to the root cause", () => {
    const render = createHumanRenderer({ stream: sink() });
    const root = new Error("upstream returned 502");
    root.name = "UpstreamError";
    const wrapper = new Error("charge failed", { cause: root });
    wrapper.stack = "Error: charge failed";

    const lines = render(record({ level: "error", fields: { err: wrapper } })).split("\n");

    expect(lines.at(-1)).toContain("└ caused by  UpstreamError: upstream returned 502");
  });

  // err 不进 key=value 段：它有自己的多行渲染，出现两次是重复报告。
  test("keeps err out of the key=value field run", () => {
    const render = createHumanRenderer({ stream: sink() });
    const error = new Error("boom");
    error.stack = "Error: boom";

    const line = render(record({ fields: { err: error, orderId: 7 } }));

    expect(line).toContain("orderId=7");
    expect(line).not.toContain("err=");
  });
});
