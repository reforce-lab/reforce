import type { TransactionTckHarness } from "@/harness";

// 用例是数据，不是 test() 调用（本包的地基）：runTransactionTck 只负责把这份列表映射成
// describe/test，因此自测可以退化成同进程的循环——给故意写错的假 manager 跑一遍列表、收集
// 失败的 id、断言精确等于预期集合。不需要嵌套 Vitest 进程，也不需要解析 reporter 输出。
export interface TckCase<R> {
  // 稳定标识，自测的期望失败集与 README 的清单都按它引用。
  readonly id: string;
  readonly group: string;
  readonly name: string;
  // 非空即登记为 skip，理由进标题——跳过必须在报告里看得见。
  readonly skipReason?: string;
  run(harness: TransactionTckHarness<R>): Promise<void>;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

// 用于 B4/F1 这类"不得阻塞/不得耗尽"的用例：超过期限即失败，而不是把整个测试挂死。
export async function withDeadline<T>(
  milliseconds: number,
  label: string,
  work: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} did not settle within ${milliseconds}ms`));
    }, milliseconds);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// 错误没有被吞掉或替换：identity 相等，或原错误留在 cause 链上（adapter 允许包装成框架词汇，
// 但不许丢失根因）。
export function mentions(thrown: unknown, expected: unknown): boolean {
  let current = thrown;
  for (let depth = 0; depth < 10; depth += 1) {
    if (Object.is(current, expected)) {
      return true;
    }
    if (current === null || typeof current !== "object" || !("cause" in current)) {
      return false;
    }
    current = Reflect.get(current, "cause");
  }
  return false;
}

// 拿到被抛出的那个值本身（而不是只断言"抛了"）：A2 要的是引用相等，F2/F3 要的是 cause 链。
export async function rejectionOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject, but it resolved.");
}
