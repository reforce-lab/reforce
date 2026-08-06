import { AsyncLocalStorage } from "node:async_hooks";
import {
  isNestedTransactionManager,
  TransactionTimeoutError,
  TransactionTimeoutUnsupportedError,
} from "@reforce/context";
import { expect } from "vitest";
import { mentions, rejectionOf, sleep, type TckCase, withDeadline } from "@/case";
import type { TransactionTckHarness } from "@/harness";

// E 组：adapter 不得破坏调用方的 AsyncLocalStorage 传播。连接池的等待队列如果用模块求值期
// 捕获的 snapshot 恢复上下文（或从 timer 回调直接执行排队工作），调用方的 ALS 就在
// withTransaction 里断掉——事务仓、request 仓、OTel context 全部一起丢。
//
// F 组：资源与错误——连接不泄漏、故障错误不被吞、timeout 抛框架词汇且语义不得近似。

const sentinel = new AsyncLocalStorage<string>();

export function asyncContextCases<R>(harness: TransactionTckHarness<R>): readonly TckCase<R>[] {
  const cases: TckCase<R>[] = [
    {
      id: "E5",
      group: "E async context",
      name: "withTransaction does not break the caller's AsyncLocalStorage",
      async run(h) {
        await sentinel.run("caller", async () => {
          await h.manager.withTransaction({}, async () => {
            expect(sentinel.getStore()).toBe("caller");
          });
        });
      },
    },
  ];
  if (!isNestedTransactionManager(harness.manager)) {
    return cases;
  }
  const nested = harness.manager;
  cases.push({
    id: "E5b",
    group: "E async context",
    name: "withSavepoint does not break the caller's AsyncLocalStorage",
    async run(h) {
      await sentinel.run("caller", async () => {
        await h.manager.withTransaction({}, async (resource) => {
          await nested.withSavepoint(resource, async () => {
            expect(sentinel.getStore()).toBe("caller");
          });
        });
      });
    },
  });
  return cases;
}

function poolCases<R>(harness: TransactionTckHarness<R>): readonly TckCase<R>[] {
  const attempts = harness.capabilities.poolSize + 5;
  return [
    {
      id: "F1",
      group: "F resources",
      name: `${attempts} failing transactions in a row do not exhaust the pool`,
      async run(h) {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          await rejectionOf(
            h.manager.withTransaction({}, async () => {
              throw new Error(`F1 attempt ${attempt}`);
            }),
          );
        }

        await withDeadline(
          2_000,
          "a transaction after the failing run",
          h.manager.withTransaction({}, async () => undefined),
        );
      },
    },
    {
      id: "F1b",
      group: "F resources",
      name: `${attempts} successful transactions in a row do not exhaust the pool`,
      async run(h) {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          await h.manager.withTransaction({}, async () => undefined);
        }

        await withDeadline(
          2_000,
          "a transaction after the successful run",
          h.manager.withTransaction({}, async () => undefined),
        );
      },
    },
  ];
}

function faultCases<R>(harness: TransactionTckHarness<R>): readonly TckCase<R>[] {
  const faults = harness.faults;
  const missing = "the harness does not provide fault injection";
  if (faults === undefined) {
    return [
      {
        id: "F2",
        group: "F resources",
        name: "a failure to acquire a connection is not swallowed",
        skipReason: missing,
        run: async () => undefined,
      },
      {
        id: "F3",
        group: "F resources",
        name: "a failure to commit is not swallowed",
        skipReason: missing,
        run: async () => undefined,
      },
    ];
  }
  return [
    {
      id: "F2",
      group: "F resources",
      name: "a failure to acquire a connection is not swallowed",
      async run(h) {
        const expected = faults.failNextAcquire();

        const caught = await rejectionOf(h.manager.withTransaction({}, async () => "unreachable"));

        expect(mentions(caught, expected)).toBe(true);
      },
    },
    {
      id: "F3",
      group: "F resources",
      name: "a failure to commit is not swallowed",
      async run(h) {
        const expected = faults.failNextCommit();

        const caught = await rejectionOf(h.manager.withTransaction({}, async () => "committed"));

        expect(mentions(caught, expected)).toBe(true);
      },
    },
  ];
}

// 预算取得小而不是零：变异矩阵会把整套用例跑十几遍，超时组的墙钟是全包最贵的部分。
const timeoutBudget = 60;
const overrun = timeoutBudget * 4;

function timeoutCases<R>(harness: TransactionTckHarness<R>): readonly TckCase<R>[] {
  if (!harness.capabilities.timeout) {
    return [
      {
        id: "F4N",
        group: "F resources",
        name: "an adapter without per-transaction timeouts must reject a declared timeout",
        async run(h) {
          const caught = await rejectionOf(
            h.manager.withTransaction({ timeout: timeoutBudget }, async () => undefined),
          );

          // 静默忽略是被禁止的第三态：不能实现就抛错，与 isolation 同一条纪律。
          expect(caught).toBeInstanceOf(TransactionTimeoutUnsupportedError);
        },
      },
    ];
  }
  return [
    {
      id: "F4",
      group: "F resources",
      name: "an overrunning transaction is rejected with the framework's timeout error",
      async run(h) {
        const caught = await rejectionOf(
          h.manager.withTransaction({ timeout: timeoutBudget }, async () => {
            await sleep(overrun);
          }),
        );

        // 框架词汇而非驱动私有错误码：调用方 catch 一个类型即可。
        expect(caught).toBeInstanceOf(TransactionTimeoutError);
      },
    },
    {
      id: "F5",
      group: "F resources",
      name: "a slow transaction built from many fast statements still times out",
      async run(h) {
        // statement_timeout 一类的近似实现在这里通过不了：每条语句都很快，但边界跑满。
        // 按真实墙钟循环而不是按固定条数：语句本身有多快由 adapter 决定，条数说明不了问题。
        const caught = await rejectionOf(
          h.manager.withTransaction({ timeout: timeoutBudget }, async (resource) => {
            const startedAt = performance.now();
            while (performance.now() - startedAt < timeoutBudget * 3) {
              await h.write(resource, "f5", String(performance.now()));
              await sleep(5);
            }
          }),
        );

        expect(caught).toBeInstanceOf(TransactionTimeoutError);
      },
    },
    {
      id: "F6",
      group: "F resources",
      name: "a transaction that stops issuing statements still times out",
      async run(h) {
        // 只有 F5 时，"每条语句发出前检查累计墙钟"的实现能蒙混过关——它其实不满足边界墙钟
        // 语义。F6 逼出真正的 Promise.race(fn, timer) 形态。
        const caught = await rejectionOf(
          h.manager.withTransaction({ timeout: timeoutBudget }, async (resource) => {
            await h.write(resource, "f6", "one statement");
            await sleep(overrun);
          }),
        );

        expect(caught).toBeInstanceOf(TransactionTimeoutError);
      },
    },
    {
      id: "F7",
      group: "F resources",
      name: "a timed-out transaction has rolled back its writes",
      async run(h) {
        await rejectionOf(
          h.manager.withTransaction({ timeout: timeoutBudget }, async (resource) => {
            await h.write(resource, "f7", "rolled-back");
            await sleep(overrun);
          }),
        );

        await expect(h.readOutside("f7")).resolves.toBeUndefined();
      },
    },
  ];
}

export function resourceCases<R>(harness: TransactionTckHarness<R>): readonly TckCase<R>[] {
  return [...poolCases(harness), ...faultCases(harness), ...timeoutCases(harness)];
}
