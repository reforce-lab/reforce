import { expect } from "vitest";
import { rejectionOf, type TckCase, withDeadline } from "@/case";
import type { TransactionTckHarness } from "@/harness";

// A 组：契约的最基本承诺——提交/回滚可见性、任何 throw 原样重抛、返回值原样传出。
// B 组：独立性——withTransaction 必须开启一个与任何外层事务无关的全新事务。B 组是整套 TCK
// 里最重要的一组，因为"必须显式绕过 ORM 的传播/ambient context"是意图性条款，只能验后果。

// A 组不看 capabilities：这几条是每个 adapter 无条件要满足的。
export function basicCases<R>(): readonly TckCase<R>[] {
  return [
    {
      id: "A1",
      group: "A basics",
      name: "a committed write is visible from outside the transaction",
      async run(h) {
        await h.manager.withTransaction({}, async (resource) => {
          await h.write(resource, "a1", "committed");
        });

        await expect(h.readOutside("a1")).resolves.toBe("committed");
      },
    },
    {
      id: "A2",
      group: "A basics",
      name: "any thrown value is rethrown identically after the rollback",
      async run(h) {
        const thrown = { marker: Symbol("A2") };

        const caught = await rejectionOf(
          h.manager.withTransaction({}, async () => {
            throw thrown;
          }),
        );

        // identity 相等而不只是"抛了个错"：scoped 回调把"任何 throw 回滚"变成结构性质，
        // 但这个保证只覆盖框架、不覆盖 adapter 内部。凡是 adapter 需要手写
        // try/catch/rollback 的（node-postgres、Kysely 的 ControlledTransaction 路线），
        // 结构保证退化成内部约定，本用例是那条退化路径上唯一的验证手段。
        expect(Object.is(caught, thrown)).toBe(true);
      },
    },
    {
      id: "A3",
      group: "A basics",
      name: "the callback return value is passed through unchanged",
      async run(h) {
        const value = { rows: [1, 2, 3] };

        const result = await h.manager.withTransaction({}, async () => value);

        expect(Object.is(result, value)).toBe(true);
      },
    },
    {
      id: "A4",
      group: "A basics",
      name: "a transaction reads back its own uncommitted write",
      async run(h) {
        await h.manager.withTransaction({}, async (resource) => {
          await h.write(resource, "a4", "self");
          await expect(h.read(resource, "a4")).resolves.toBe("self");
        });
      },
    },
    {
      id: "A5",
      group: "A basics",
      name: "an empty options object never raises an unsupported-capability error",
      async run(h) {
        // 不支持 timeout 的 adapter 不得把"没有声明 timeout"误判成"声明了 timeout"。
        // 只断言"不抛"：返回值的原样传出是 A3 的职责，两个用例不重叠。
        await h.manager.withTransaction({}, async () => undefined);
      },
    },
    {
      id: "A6",
      group: "A basics",
      name: "a write is invisible from outside after the callback throws",
      async run(h) {
        await rejectionOf(
          h.manager.withTransaction({}, async (resource) => {
            await h.write(resource, "a6", "rolled-back");
            throw new Error("A6");
          }),
        );

        await expect(h.readOutside("a6")).resolves.toBeUndefined();
      },
    },
  ];
}

export function independenceCases<R>(harness: TransactionTckHarness<R>): readonly TckCase<R>[] {
  const { concurrentWriters } = harness.capabilities;
  const singleWriter = "the harness declares concurrentWriters: false";
  return [
    {
      id: "B0",
      group: "B independence",
      name: "an uncommitted write is invisible to the bypass connection (harness self-check)",
      async run(h) {
        // harness 自检：readOutside 若偷用事务内连接，提交与回滚的差别就消失，B/C/D 组
        // 全部退化成永真断言。这里只挡得住最粗暴的形态——README 有红字警告。
        await h.manager.withTransaction({}, async (resource) => {
          await h.write(resource, "b0", "pending");
          await expect(h.readOutside("b0")).resolves.toBeUndefined();
        });
      },
    },
    {
      id: "B1",
      group: "B independence",
      name: "a second transaction cannot see the outer transaction's uncommitted write",
      async run(h) {
        await h.manager.withTransaction({}, async (outer) => {
          await h.write(outer, "b1", "pending");

          await h.manager.withTransaction({}, async (inner) => {
            await expect(h.read(inner, "b1")).resolves.toBeUndefined();
          });
        });
      },
    },
    {
      id: "B2",
      group: "B independence",
      name: "an inner commit survives an outer rollback",
      skipReason: concurrentWriters ? undefined : singleWriter,
      async run(h) {
        await rejectionOf(
          h.manager.withTransaction({}, async (outer) => {
            await h.write(outer, "b2-outer", "outer");
            await h.manager.withTransaction({}, async (inner) => {
              await h.write(inner, "b2-inner", "inner");
            });
            throw new Error("B2");
          }),
        );

        // 独立性的决定性证明：内层的提交不因外层回滚而消失。
        await expect(h.readOutside("b2-inner")).resolves.toBe("inner");
        await expect(h.readOutside("b2-outer")).resolves.toBeUndefined();
      },
    },
    {
      id: "B2L",
      group: "B independence",
      name: "an inner commit survives an outer rollback (single-writer variant)",
      skipReason: concurrentWriters ? "covered in full by B2" : undefined,
      async run(h) {
        // 单写者数据库上外层不能同时持有写：外层只读，因此这条变体证不了写-写场景。
        // 完整验证等容器化 PG（ADR 0008 T5 的已知代价）。
        await rejectionOf(
          h.manager.withTransaction({}, async (outer) => {
            await h.read(outer, "b2l-inner");
            await h.manager.withTransaction({}, async (inner) => {
              await h.write(inner, "b2l-inner", "inner");
            });
            throw new Error("B2L");
          }),
        );

        await expect(h.readOutside("b2l-inner")).resolves.toBe("inner");
      },
    },
    {
      id: "B3",
      group: "B independence",
      name: "two nested withTransaction calls hand out distinct resources",
      async run(h) {
        await h.manager.withTransaction({}, async (outer) => {
          await h.manager.withTransaction({}, async (inner) => {
            // 最强的代理指标，但代理不是证明：fork 出新实例而底层连接相同的 ORM 照样通过，
            // 那种形态只有 B2 抓得住。
            expect(Object.is(outer, inner)).toBe(false);
          });
        });
      },
    },
    {
      id: "B4",
      group: "B independence",
      name: "a concurrent transaction writing another row is not blocked",
      skipReason: concurrentWriters ? undefined : singleWriter,
      async run(h) {
        await h.manager.withTransaction({}, async (outer) => {
          await h.write(outer, "b4-outer", "outer");

          await withDeadline(
            2_000,
            "the concurrent transaction",
            h.manager.withTransaction({}, async (inner) => {
              await h.write(inner, "b4-inner", "inner");
            }),
          );
        });
      },
    },
  ];
}
