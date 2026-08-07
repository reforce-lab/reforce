// 测试墙钟的两层结构（Issue #92）：外层击杀钟是 @reforce/tooling-vitest 工厂无条件设置的
// `testTimeout`/`hookTimeout`（300s，教义级常量，不接受包级调参），
// 内层是这里的停滞预算——给所有「轮询外部可观察物」的等待用，先于外层触发、抛出带现场信息的
// 错误。两层的语义都是抓「卡死」，不是管「慢」（Issue #75）：按预期耗时标定的窗口在慢平台上
// 会把「正常但偏慢」判成失败（Issue #57、#81），所以这个数只许「真卡死才够得着」，必须显著
// 大于任何合法等待、且小于外层击杀钟。
export const testStallBudgetMilliseconds = 120_000;

const pollIntervalMilliseconds = 20;

// 轮询直到 predicate 为真；停滞满预算后抛 timeoutMessage。只用于没有事件可等的外部可观察物
// （子进程状态、磁盘文件、跨进程副作用）；进程内的状态变化应当等事件本身，不要用它。
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMessage: string,
): Promise<void> {
  const deadline = Date.now() + testStallBudgetMilliseconds;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(timeoutMessage);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMilliseconds));
  }
}
