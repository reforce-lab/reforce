import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// IT 每个用例自己开一块临时目录：脚手架会创建、也会在失败时删除目录树，共用一块会互相踩。
export async function withTemporaryDirectory<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "create-reforce-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
