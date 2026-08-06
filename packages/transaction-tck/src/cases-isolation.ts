import {
  type TransactionIsolation,
  TransactionIsolationUnsupportedError,
  transactionIsolationLevels,
} from "@reforce/context";
import { expect } from "vitest";
import { rejectionOf, type TckCase } from "@/case";
import type { TransactionTckHarness } from "@/harness";

// D 组：capabilities.isolations 是双向承诺——表内正验、表外反验。反验是这组存在的主要理由：
// "底层不支持所声明级别时必须抛错、不得静默降级"没有别的验证手段。

const isolationAbbreviations = {
  READ_UNCOMMITTED: "RU",
  READ_COMMITTED: "RC",
  REPEATABLE_READ: "RR",
  SERIALIZABLE: "SER",
} as const satisfies Record<TransactionIsolation, string>;

// 快照可重复读只对这两级有意义：RU/RC 允许在同一事务内看到别人的提交。
const snapshotLevels: readonly TransactionIsolation[] = ["REPEATABLE_READ", "SERIALIZABLE"];

function supportedCases<R>(
  harness: TransactionTckHarness<R>,
  isolation: TransactionIsolation,
): readonly TckCase<R>[] {
  const tag = isolationAbbreviations[isolation];
  const key = `d-${tag.toLowerCase()}`;
  const cases: TckCase<R>[] = [
    {
      id: `D1-${tag}`,
      group: "D isolation",
      name: `a transaction declared ${isolation} opens and commits`,
      async run(h) {
        await h.manager.withTransaction({ isolation }, async (resource) => {
          await h.write(resource, key, tag);
        });

        await expect(h.readOutside(key)).resolves.toBe(tag);
      },
    },
  ];
  if (!snapshotLevels.includes(isolation) || !harness.capabilities.concurrentWriters) {
    return cases;
  }
  cases.push({
    id: `D3-${tag}`,
    group: "D isolation",
    name: `${isolation} keeps a repeatable snapshot across a concurrent commit`,
    async run(h) {
      await h.manager.withTransaction({ isolation }, async (resource) => {
        // 先读一次建立快照——多数引擎的快照在第一条语句处才固定。
        await expect(h.read(resource, `${key}-snap`)).resolves.toBeUndefined();

        await h.manager.withTransaction({}, async (other) => {
          await h.write(other, `${key}-snap`, "committed-elsewhere");
        });

        await expect(h.read(resource, `${key}-snap`)).resolves.toBeUndefined();
      });
    },
  });
  return cases;
}

function unsupportedCase<R>(isolation: TransactionIsolation): TckCase<R> {
  const tag = isolationAbbreviations[isolation];
  return {
    id: `D2-${tag}`,
    group: "D isolation",
    name: `an undeclared ${isolation} must be rejected, not silently downgraded`,
    async run(h) {
      const caught = await rejectionOf(
        h.manager.withTransaction({ isolation }, async () => undefined),
      );

      expect(caught).toBeInstanceOf(TransactionIsolationUnsupportedError);
    },
  };
}

export function isolationCases<R>(harness: TransactionTckHarness<R>): readonly TckCase<R>[] {
  const declared = new Set(harness.capabilities.isolations);
  return transactionIsolationLevels.flatMap((isolation) =>
    declared.has(isolation) ? supportedCases(harness, isolation) : [unsupportedCase<R>(isolation)],
  );
}
