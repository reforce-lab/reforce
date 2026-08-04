import { rm } from "node:fs/promises";

const retryDelays = [10, 20, 40, 80, 160, 320] as const;

type RemoveOperation = (path: string) => Promise<void>;
type WaitOperation = (milliseconds: number) => Promise<unknown>;

interface WindowsRemoveRetryOperations {
  readonly remove?: RemoveOperation;
  readonly wait?: WaitOperation;
}

// Windows 上杀毒实时扫描、搜索索引或 publint 一类刚爬扫过临时树的消费者会短暂持有句柄，
// 递归删除会以 EBUSY/EPERM/ENOTEMPTY 瞬态失败（Issue #170）。这些码按 retryDelays 短退避
// 熬过瞬态锁；其他错误码是真实失败，直接抛。总退避 ~630ms，远小于 bun test 的 5s hook 超时。
function isTransientRemoveError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  return error.code === "EBUSY" || error.code === "EPERM" || error.code === "ENOTEMPTY";
}

async function removeRecursively(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function removeWithWindowsRetry(
  path: string,
  operations: WindowsRemoveRetryOperations = {},
): Promise<void> {
  const removeOperation = operations.remove ?? removeRecursively;
  const wait = operations.wait ?? sleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await removeOperation(path);
      return;
    } catch (error) {
      const retryDelay = retryDelays[attempt];
      if (retryDelay === undefined || !isTransientRemoveError(error)) {
        throw error;
      }
      await wait(retryDelay);
    }
  }
}
