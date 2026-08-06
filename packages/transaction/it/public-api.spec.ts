import { expect, test } from "vitest";
import type * as TransactionEntry from "@/index";
import {
  activeResourceFor,
  runTransactional,
  type TransactionManager,
  type TransactionOptions,
} from "@/index";

// 根入口的类型层断言（context 的 it/public-api.spec.ts 同款）：`test/index.spec.ts` 守的是
// 运行时键，纯类型导出删掉一个字都不会红——这一条由 `tsc -p it/tsconfig.json` 兜住。
//
// TransactionInfo 与 activeTransaction() 已删除（#204 定案 4 的修订）：零参签名宣称存在一个
// "当前事务"单数对象，而一次请求里可以有 N 条互不相关的事务栈，它们之间没有序——那个对象
// 不存在。探查恒需要钥匙，走 activeResourceFor(manager)。
function verifyTheSingularCurrentTransactionSurfaceIsGone(
  // @ts-expect-error TransactionInfo was removed together with activeTransaction().
  _info: TransactionEntry.TransactionInfo,
  // @ts-expect-error activeTransaction() was removed: probing a boundary always takes a manager.
  _probe: typeof TransactionEntry.activeTransaction,
): void {}

void verifyTheSingularCurrentTransactionSurfaceIsGone;

// 只从公开入口装配一遍完整回路：runTransactional 建账本 → adapter 的 current() 用
// activeResourceFor 读账本 → 用户拿到本次边界的句柄。传播矩阵在 test/transactional.spec.ts。
test("the public entry alone is enough to write and read the transaction ledger", async () => {
  const manager: TransactionManager<string> = {
    async withTransaction<T>(
      _options: TransactionOptions,
      fn: (resource: string) => Promise<T>,
    ): Promise<T> {
      return await fn("tx");
    },
    current(): string {
      return activeResourceFor(this) ?? "pool";
    },
  };

  const inside = await runTransactional(manager, { timeout: 600_000 }, async () =>
    manager.current(),
  );

  expect(inside).toBe("tx");
  expect(manager.current()).toBe("pool");
});
