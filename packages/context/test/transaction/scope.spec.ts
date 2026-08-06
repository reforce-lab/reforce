import { describe, expect, test } from "vitest";
import type { TransactionManager, TransactionOptions } from "@/transaction/manager";
import type { ActiveTransaction } from "@/transaction/scope";
import { activeResourceFor, activeTransaction, runInTransaction } from "@/transaction/scope";

// 事务 ALS 仓（#204 定案 4）：flow-local 记录、嵌套影子化、并发 flow 互不可见——传播语义的
// 挂起/恢复全建立在这三条性质上。记录按 manager 身份分槽（ADR 0008 T4 多数据源定案），
// 多数据源因此天然不串。

function managerOf(label: string): TransactionManager<string> {
  return {
    async withTransaction<T>(
      _options: TransactionOptions,
      fn: (resource: string) => Promise<T>,
    ): Promise<T> {
      return await fn(label);
    },
    current(): string {
      return activeResourceFor(this) ?? label;
    },
  };
}

function recordOf(resource: string): ActiveTransaction {
  return { resource, isolation: undefined, timeout: undefined, suspended: [] };
}

describe("transaction scope", () => {
  const manager = managerOf("pool");

  test("no transaction is active outside a boundary", () => {
    expect(activeTransaction()).toBeUndefined();
  });

  test("a nested run shadows the outer record and restores it afterwards", async () => {
    await runInTransaction(manager, recordOf("outer"), async () => {
      expect(activeResourceFor(manager)).toBe("outer");

      await runInTransaction(manager, recordOf("inner"), async () => {
        expect(activeResourceFor(manager)).toBe("inner");
      });

      expect(activeResourceFor(manager)).toBe("outer");
    });

    expect(activeResourceFor(manager)).toBeUndefined();
  });

  test("concurrent flows do not observe each other's transactions", async () => {
    const seen: Record<string, unknown> = {};
    const flow = (name: string) =>
      runInTransaction(manager, recordOf(name), async () => {
        await Promise.resolve();
        seen[name] = activeResourceFor(manager);
      });

    await Promise.all([flow("left"), flow("right")]);

    expect(seen).toEqual({ left: "left", right: "right" });
  });

  test("two managers keep their own resource inside one another's boundaries", async () => {
    const primary = managerOf("primary");
    const analytics = managerOf("analytics");

    await runInTransaction(primary, recordOf("primary-tx"), async () => {
      await runInTransaction(analytics, recordOf("analytics-tx"), async () => {
        expect(activeResourceFor(primary)).toBe("primary-tx");
        expect(activeResourceFor(analytics)).toBe("analytics-tx");
      });

      expect(activeResourceFor(analytics)).toBeUndefined();
      expect(activeResourceFor(primary)).toBe("primary-tx");
    });
  });

  test("the probe surface reports the declared boundary metadata without the resource", async () => {
    await runInTransaction(
      manager,
      { resource: "tx", isolation: "SERIALIZABLE", timeout: 5_000, suspended: [] },
      async () => {
        expect(activeTransaction()).toEqual({ isolation: "SERIALIZABLE", timeout: 5_000 });
      },
    );
  });

  test("current() resolves to the active resource inside a boundary and to the pool outside", async () => {
    expect(manager.current()).toBe("pool");

    await runInTransaction(manager, recordOf("tx"), async () => {
      expect(manager.current()).toBe("tx");
    });

    expect(manager.current()).toBe("pool");
  });
});
