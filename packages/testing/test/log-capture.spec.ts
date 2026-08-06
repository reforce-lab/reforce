import { describe, expect, test } from "vitest";
import { createLogCapture } from "@/log-capture";

describe("log capture", () => {
  test("captures a record with its logger name and fields", () => {
    const capture = createLogCapture({ now: () => 1_700_000_000_000 });

    capture.factory.create("orders").info({ orderId: 7 }, "created");

    expect(capture.records()).toEqual([
      {
        level: "info",
        name: "orders",
        time: 1_700_000_000_000,
        message: "created",
        fields: { orderId: 7 },
      },
    ]);
  });

  test("keeps records in the order they were written", () => {
    const capture = createLogCapture();
    const logger = capture.factory.create("orders");

    logger.info(undefined, "first");
    logger.warn(undefined, "second");

    expect(capture.records().map((record) => record.message)).toEqual(["first", "second"]);
  });

  test("filters by level and by logger name", () => {
    const capture = createLogCapture();
    capture.factory.create("orders").error(undefined, "boom");
    capture.factory.create("payments").info(undefined, "ok");

    expect(capture.records({ level: "error" }).map((record) => record.name)).toEqual(["orders"]);
    expect(capture.records({ name: "payments" }).map((record) => record.message)).toEqual(["ok"]);
  });

  // 与真实绑定同一条不变量（不变量 8）：捕获替身若无条件记录，「关掉级别后没有日志」
  // 这类断言就永远测不出问题。
  test("drops a record below the configured level", () => {
    const capture = createLogCapture({ level: "warn" });

    capture.factory.create("orders").debug(undefined, "noise");

    expect(capture.records()).toEqual([]);
  });

  test("reports isEnabled consistently with what it captures", () => {
    const logger = createLogCapture({ level: "warn" }).factory.create("orders");

    expect([logger.isEnabled("debug"), logger.isEnabled("error")]).toEqual([false, true]);
  });

  test("clears what it captured", () => {
    const capture = createLogCapture();
    capture.factory.create("orders").info(undefined, "gone");

    capture.clear();

    expect(capture.records()).toEqual([]);
  });
});
