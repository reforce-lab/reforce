// 进程入口，不是可 import 的模块：由 `spawn(node, [<本文件>, cliEntry, ...args])` 拉起，
// 改写自身 argv 后再 import CLI，好让被测 CLI 看到伪造的命令行；父进程通过 IPC 消息
// 触发 SIGINT/SIGBREAK，绕开 Windows 无法向子进程真实发送这两个信号的限制。
// 放在 tooling/testing 而非某一层测试目录下，是因为 e2e 与 packages/cli 的 IT 都要用它，
// 而两层的 support 目录互相不可见（Issue #35）。
import { pathToFileURL } from "node:url";

const cliEntry = process.argv[2];
const cliArguments = process.argv.slice(3);
if (cliEntry === undefined) {
  throw new Error("Expected the built CLI entry path.");
}

process.argv = [process.execPath, cliEntry, ...cliArguments];
const onMessage = (message: unknown) => {
  if (
    typeof message !== "object" ||
    message === null ||
    Reflect.get(message, "type") !== "reforce:e2e-signal"
  ) {
    return;
  }
  const signal = Reflect.get(message, "signal");
  if (signal === "SIGINT") {
    process.emit("SIGINT");
  } else if (signal === "SIGBREAK") {
    process.emit("SIGBREAK");
  }
};
process.on("message", onMessage);
try {
  await import(pathToFileURL(cliEntry).href);
} finally {
  process.off("message", onMessage);
  if (process.connected) {
    process.disconnect?.();
  }
}
