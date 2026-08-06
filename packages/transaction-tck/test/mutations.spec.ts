import { describe, expect, test } from "vitest";
import { collectTransactionTckFailures } from "@/run";
import { memoryHarness } from "./support/memory-manager";
import type { MemoryMutations } from "./support/mutations";

// 变异矩阵（本包最重要的部分）：每个变异断言**精确的**失败集——少一条说明 TCK 抓不住，
// 多一条说明某用例在用不相干的路径附带失败、诊断价值是假的。期望值先按推理写好再跑；
// 任何不符当作发现处理，不许倒过来把实测结果抄进表里。

interface Mutant {
  readonly label: string;
  readonly mutations: MemoryMutations;
  readonly expected: readonly string[];
}

const mutants: readonly Mutant[] = [
  {
    // ORM 默认 REQUIRED 传播（MikroORM 的 em.transactional / global EM 就是这个形态）。
    label: "reuses the outer resource instead of beginning a new transaction",
    mutations: { reuseOuterResource: true },
    expected: ["B1", "B2", "B3", "D3-RR", "D3-SER"],
  },
  {
    label: "wraps the thrown value instead of rethrowing it",
    mutations: { wrapThrown: true },
    expected: ["A2"],
  },
  {
    label: "swallows a commit failure",
    mutations: { swallowCommitError: true },
    expected: ["F3"],
  },
  {
    label: "wraps the callback return value",
    mutations: { wrapReturnValue: true },
    expected: ["A3"],
  },
  {
    label: "commits even though the callback threw",
    mutations: { commitOnThrow: true },
    expected: ["A6", "B2", "C3"],
  },
  {
    // C4 也在集合里：它的第二条断言（内层的写不得可见）与 C1b 检测的是同一个缺陷。
    // 这是与计划表的一处偏差，按"任何不符当作发现处理"记在这里而不是改用例去凑表。
    label: "catches a savepoint failure without rolling back to it",
    mutations: { savepointCatchWithoutRollback: true },
    expected: ["C1b", "C4", "C6"],
  },
  {
    label: "accepts a timeout option and never enforces it",
    mutations: { ignoreTimeout: true },
    expected: ["F4", "F5", "F6", "F7"],
  },
  {
    label: "raises a driver-private error instead of the framework's timeout error",
    mutations: { driverTimeoutError: true },
    expected: ["F4", "F5", "F6"],
  },
  {
    label: "reports the timeout but does not roll back",
    mutations: { timeoutWithoutRollback: true },
    expected: ["F7"],
  },
  {
    // statement_timeout 冒充事务超时。F4 也在集合里：一个"只约束单条语句"的实现对任何
    // 由快语句组成的边界都不设限，而 F4 本身就是一次不发慢语句的超时——计划表把 F4 漏了。
    label: "passes the budget off as a per-statement timeout",
    mutations: { statementScopedTimeout: true },
    expected: ["F4", "F5", "F6", "F7"],
  },
  {
    // 每条语句发出前检查累计墙钟：F5 由许多语句组成，检查会在某一条上命中，因此躲得过；
    // F4/F6 在最后一条语句之后才超时，检查永远不再发生。F6 存在的全部理由就是这一条。
    // F7 一并失败（与计划表的偏差）：它的形状与 F6 相同，超时既然没发生，写就被提交了——
    // 这不是附带失败，是同一个缺陷的第二个后果。
    label: "checks the accumulated wall clock only when a statement is issued",
    mutations: { wallClockCheckedAtStatements: true },
    expected: ["F4", "F6", "F7"],
  },
  {
    label: "loses the caller's async context in the pool",
    mutations: { dropAsyncContext: true },
    expected: ["E5", "E5b"],
  },
  {
    label: "silently accepts an isolation level it does not support",
    mutations: { ignoreUnsupportedIsolation: true },
    expected: ["D2-RU"],
  },
  {
    label: "runs every isolation level as READ_COMMITTED",
    mutations: { allIsolationsAsReadCommitted: true },
    expected: ["D3-RR", "D3-SER"],
  },
];

describe("transaction TCK mutation matrix", () => {
  test("the reference implementation passes every registered case", async () => {
    const failed = await collectTransactionTckFailures(memoryHarness());

    // 守住"TCK 没有过度规定"：任何超出契约的要求都会在这里红。
    expect(failed).toEqual([]);
  });

  for (const mutant of mutants) {
    test(`catches an adapter that ${mutant.label}`, async () => {
      const failed = await collectTransactionTckFailures(
        memoryHarness({ name: mutant.label, mutations: mutant.mutations }),
      );

      expect([...failed].toSorted()).toEqual([...mutant.expected].toSorted());
    });
  }
});
