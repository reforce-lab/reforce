import { realpath } from "node:fs/promises";

let resolution: Promise<string> | undefined;

// 子进程 harness 统一用当前 Node 可执行文件（vitest 进程即 Node）；realpath 穿透
// fnm/nvm 等版本管理器的 shim 层，保证 spawn 到的是真实二进制。
export function resolveNodeExecutable(): Promise<string> {
  resolution ??= realpath(process.execPath);
  return resolution;
}
