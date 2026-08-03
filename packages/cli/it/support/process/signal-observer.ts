// 在 harness 子进程内安装信号观察器，收到信号就通过 IPC 回报给 spec。
// 平台差异在这里收口：Windows 上 SIGTERM 不可用，改用 SIGBREAK——它是 windows-signal-harness
// 能注入的另一个信号（Issue #35）。返回的函数用于卸载，harness 必须在退出前调用，
// 否则残留的监听器会让子进程挂着不退。
export function observeShutdownSignals(): () => void {
  const signalNames: NodeJS.Signals[] =
    process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  const onSignal = (signal: NodeJS.Signals) => {
    process.send?.({ type: "harness:signal-observed", signal });
  };
  for (const signal of signalNames) {
    process.on(signal, onSignal);
  }
  return () => {
    for (const signal of signalNames) {
      process.off(signal, onSignal);
    }
  };
}
