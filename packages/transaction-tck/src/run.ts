import { beforeEach, describe, test } from "vitest";
import type { TckCase } from "@/case";
import { basicCases, independenceCases } from "@/cases-basics";
import { isolationCases } from "@/cases-isolation";
import { asyncContextCases, resourceCases } from "@/cases-resources";
import { savepointCases } from "@/cases-savepoint";
import type { TransactionTckHarness } from "@/harness";

// 契约的可执行定义（ADR 0008 T5）。adapter 作者写一个 harness 就得到全套行为断言，形态参照
// @keyv/test-suite。用例是数据（TckCase[]），runTransactionTck 只负责把它映射成
// describe/test——本包自身的正确性因此可以用同进程的变异矩阵证明，见 test/mutations.spec.ts。

export function transactionTckCases<R>(harness: TransactionTckHarness<R>): readonly TckCase<R>[] {
  return [
    ...basicCases<R>(),
    ...independenceCases(harness),
    ...savepointCases(harness),
    ...isolationCases(harness),
    ...asyncContextCases(harness),
    ...resourceCases(harness),
  ];
}

// 同进程跑一遍全部用例，返回失败的 id（源码序）。变异矩阵靠它断言"TCK 抓得住哪些错误"，
// 不需要嵌套 Vitest 进程，也不需要解析 reporter 输出。skip 的用例不参与。
export async function collectTransactionTckFailures<R>(
  harness: TransactionTckHarness<R>,
): Promise<readonly string[]> {
  const failed: string[] = [];
  for (const tckCase of transactionTckCases(harness)) {
    if (tckCase.skipReason !== undefined) {
      continue;
    }
    await harness.reset();
    try {
      await tckCase.run(harness);
    } catch {
      failed.push(tckCase.id);
    }
  }
  return failed;
}

export function runTransactionTck<R>(harness: TransactionTckHarness<R>): void {
  const cases = transactionTckCases(harness);
  const groups = [...new Set(cases.map((tckCase) => tckCase.group))];
  describe(`transaction contract: ${harness.name}`, () => {
    beforeEach(async () => {
      await harness.reset();
    });

    for (const group of groups) {
      describe(group, () => {
        for (const tckCase of cases.filter((entry) => entry.group === group)) {
          const title = `${tckCase.id}: ${tckCase.name}`;
          if (tckCase.skipReason !== undefined) {
            // 跳过的理由进标题：报告里看不见的跳过等于没跳过。
            test.skip(`${title} [skipped — ${tckCase.skipReason}]`, () => undefined);
            continue;
          }
          test(title, async () => {
            await tckCase.run(harness);
          });
        }
      });
    }
  });
}
