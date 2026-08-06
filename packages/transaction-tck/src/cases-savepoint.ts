import { isNestedTransactionManager, type NestedTransactionManager } from "@reforce/context";
import { expect } from "vitest";
import { rejectionOf, type TckCase } from "@/case";
import type { TransactionTckHarness } from "@/harness";

// C 组只在 manager 实现 NestedTransactionManager 时登记：能力判定的唯一真相是
// isNestedTransactionManager（@reforce/context 导出），harness 因此没有 savepoint 布尔——
// 声明只可能与守卫一致（冗余）或矛盾（噪声）。

function nestedOf<R>(harness: TransactionTckHarness<R>): NestedTransactionManager<R> {
  if (!isNestedTransactionManager(harness.manager)) {
    throw new Error("Savepoint cases must not be registered for a plain TransactionManager.");
  }
  return harness.manager;
}

export function savepointCases<R>(harness: TransactionTckHarness<R>): readonly TckCase<R>[] {
  if (!isNestedTransactionManager(harness.manager)) {
    return [];
  }
  return [
    {
      id: "C1",
      group: "C savepoint",
      name: "a value thrown inside a savepoint is rethrown identically",
      async run(h) {
        const nested = nestedOf(h);
        const thrown = { marker: Symbol("C1") };

        await h.manager.withTransaction({}, async (outer) => {
          const caught = await rejectionOf(
            nested.withSavepoint(outer, async () => {
              throw thrown;
            }),
          );

          expect(Object.is(caught, thrown)).toBe(true);
        });
      },
    },
    {
      id: "C1b",
      group: "C savepoint",
      name: "a write rolled back to the savepoint stays invisible after the outer commit",
      async run(h) {
        const nested = nestedOf(h);

        await h.manager.withTransaction({}, async (outer) => {
          await rejectionOf(
            nested.withSavepoint(outer, async (inner) => {
              await h.write(inner, "c1b", "discarded");
              throw new Error("C1b");
            }),
          );
        });

        await expect(h.readOutside("c1b")).resolves.toBeUndefined();
      },
    },
    {
      id: "C2",
      group: "C savepoint",
      name: "a savepoint that returns normally is committed with the outer transaction",
      async run(h) {
        const nested = nestedOf(h);

        await h.manager.withTransaction({}, async (outer) => {
          await nested.withSavepoint(outer, async (inner) => {
            await h.write(inner, "c2", "kept");
          });
        });

        await expect(h.readOutside("c2")).resolves.toBe("kept");
      },
    },
    {
      id: "C3",
      group: "C savepoint",
      name: "a released savepoint disappears when the outer transaction rolls back",
      async run(h) {
        const nested = nestedOf(h);

        await rejectionOf(
          h.manager.withTransaction({}, async (outer) => {
            await nested.withSavepoint(outer, async (inner) => {
              await h.write(inner, "c3", "kept-then-lost");
            });
            throw new Error("C3");
          }),
        );

        await expect(h.readOutside("c3")).resolves.toBeUndefined();
      },
    },
    {
      id: "C4",
      group: "C savepoint",
      name: "two levels of savepoint roll back independently",
      async run(h) {
        const nested = nestedOf(h);

        await h.manager.withTransaction({}, async (outer) => {
          await nested.withSavepoint(outer, async (level1) => {
            await h.write(level1, "c4-outer", "kept");
            await rejectionOf(
              nested.withSavepoint(level1, async (level2) => {
                await h.write(level2, "c4-inner", "discarded");
                throw new Error("C4");
              }),
            );
          });
        });

        await expect(h.readOutside("c4-outer")).resolves.toBe("kept");
        await expect(h.readOutside("c4-inner")).resolves.toBeUndefined();
      },
    },
    {
      id: "C6",
      group: "C savepoint",
      name: "the outer transaction can still run statements and commit after a savepoint rollback",
      async run(h) {
        const nested = nestedOf(h);

        // PG 上最高发的 adapter bug：只 catch 不发 ROLLBACK TO SAVEPOINT，连接进 aborted
        // 态，外层此后每条语句都失败。C1b 只看得见"写没了"，看不见"连接废了"。
        await h.manager.withTransaction({}, async (outer) => {
          await rejectionOf(
            nested.withSavepoint(outer, async (inner) => {
              await h.write(inner, "c6-discarded", "discarded");
              throw new Error("C6");
            }),
          );

          await h.write(outer, "c6-after", "after");
        });

        await expect(h.readOutside("c6-after")).resolves.toBe("after");
        await expect(h.readOutside("c6-discarded")).resolves.toBeUndefined();
      },
    },
  ];
}
