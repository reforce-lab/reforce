// checker 接入层的两类错误(RFC 0012 S1,#273)。语义刻意不同:
// - CheckerUnavailableError 是环境事实(tsgo 子进程崩溃/会话已关闭),compile.ts 统一捕获并翻译成
//   TYPE_CHECKER_UNAVAILABLE 诊断,下一次 compile 由 supervisor 自动重建会话;
// - StaleCheckerHandleError 是程序 bug(跨 snapshot 使用旧句柄)。tsgo 的 Type/Signature 句柄 id 在
//   新 snapshot 里会撞车并静默返回错误答案(spike 实测),所以这里必须硬 throw,不允许翻译成诊断。
export class CheckerUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CheckerUnavailableError";
  }
}

export class StaleCheckerHandleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleCheckerHandleError";
  }
}
