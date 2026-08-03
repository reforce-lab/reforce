import { lstat } from "node:fs/promises";

// node:fs 只在 `code` 上区分失败原因，而 throw 出来的值不保证是 Error，所以判定必须先过
// `instanceof Error` 与 `"code" in error` 两道窄化。这两道以前在 lease、directory transaction、
// windows rename retry 和 start 命令里各写各的，任何一处漏写一道，都会把非 Error 的抛出物静默
// 归类成「路径不存在」。
export function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

// 恢复路径上「路径不存在」等价于「这一步无事可做」，可以安全跳过；其余 errno（EACCES、EIO……）
// 必须继续抛出，吞掉它们等于把权限或 IO 故障当成空目录，接着往下走会覆盖真实数据。
export function isMissingPathError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

// 用 lstat 而不是 stat：调用方（事务清理、rename 发布）关心的是「这个名字有没有被占用」，
// 符号链接本身就算占用，跟随链接去看目标存不存在会得到相反的答案。
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}
