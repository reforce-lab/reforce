import { describe, expect, test } from "vitest";
import type { ActiveTransaction } from "@/transaction/scope";
import { activeTransaction, runInTransaction } from "@/transaction/scope";

// 事务 ALS 仓（#204 定案 4）：flow-local 记录、嵌套影子化、并发 flow 互不可见——传播语义的
// 挂起/恢复全建立在这三条性质上。

function recordOf(resource: string): ActiveTransaction {
  return { resource, isolation: undefined };
}

describe("transaction scope", () => {
  test("no transaction is active outside a boundary", () => {
    expect(activeTransaction()).toBeUndefined();
  });

  test("a nested run shadows the outer record and restores it afterwards", async () => {
    await runInTransaction(recordOf("outer"), async () => {
      expect(activeTransaction()?.resource).toBe("outer");

      await runInTransaction(recordOf("inner"), async () => {
        expect(activeTransaction()?.resource).toBe("inner");
      });

      expect(activeTransaction()?.resource).toBe("outer");
    });

    expect(activeTransaction()).toBeUndefined();
  });

  test("concurrent flows do not observe each other's transactions", async () => {
    const seen: Record<string, unknown> = {};
    const flow = (name: string) =>
      runInTransaction(recordOf(name), async () => {
        await Promise.resolve();
        seen[name] = activeTransaction()?.resource;
      });

    await Promise.all([flow("left"), flow("right")]);

    expect(seen).toEqual({ left: "left", right: "right" });
  });
});
