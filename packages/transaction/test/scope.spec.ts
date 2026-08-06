import { describe, expect, test } from "vitest";
import type { TransactionManager, TransactionOptions } from "@/manager";
import type { ActiveTransaction } from "@/scope";
import { activeRecordFor, activeResourceFor, runInTransaction } from "@/scope";

// 事务 ALS 仓（#204 定案 4）：flow-local 记录、嵌套影子化、并发 flow 互不可见——传播语义的
// 挂起/恢复全建立在这三条性质上。记录按 manager 身份分槽，下面那条双 manager 用例是"ALS 按
// manager 分槽"的唯一可执行证据。

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
    expect(activeResourceFor(manager)).toBeUndefined();
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

  test("the in-package probe reports the metadata the boundary declared", async () => {
    await runInTransaction(
      manager,
      { resource: "tx", isolation: "SERIALIZABLE", timeout: 5_000, suspended: [] },
      async () => {
        expect(activeRecordFor(manager)).toEqual({
          resource: "tx",
          isolation: "SERIALIZABLE",
          timeout: 5_000,
          suspended: [],
        });
      },
    );
  });

  // 探查恒需要钥匙（#204 定案 4 的修订）：没有"当前事务"这个单数对象，问哪个 manager 就得
  // 把哪个 manager 递进来——只在 A 上开了边界，B 照样一无所知。
  test("a boundary on one manager leaves another manager outside any transaction", async () => {
    const opened = managerOf("opened");
    const untouched = managerOf("untouched");

    await runInTransaction(opened, recordOf("opened-tx"), async () => {
      expect(activeRecordFor(untouched)).toBeUndefined();
    });
  });

  test("current() resolves to the active resource inside a boundary and to the pool outside", async () => {
    expect(manager.current()).toBe("pool");

    await runInTransaction(manager, recordOf("tx"), async () => {
      expect(manager.current()).toBe("tx");
    });

    expect(manager.current()).toBe("pool");
  });
});
