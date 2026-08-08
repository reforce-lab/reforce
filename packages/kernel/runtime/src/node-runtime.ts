// engines.node（>=24）的运行时守门：CLI 入口与 dev/start 派生子进程共用同一个 node 可执行
// 文件，低于下限直接失败，不让应用带着旧语法/API 支持跑进难以归因的运行时错误。
export function requireNodeExecutable(): string {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isNaN(major) || major < 24) {
    throw new Error("Reforce requires Node.js >= 24.");
  }
  return process.execPath;
}
