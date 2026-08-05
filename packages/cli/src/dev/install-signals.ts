import { dirname, join } from "node:path";
import type { CompilerWatchInputs } from "@/compiler-types";
import { pathExists } from "@/project/fs-error";

// ADR 0004（#120）决策 17、Issue #148：dev loop 的 install 信号面。依赖增删发生在应用
// package.json；install 的收尾信号是 pnpm-lock.yaml 写入；node_modules 在 install 期间是半成品，
// 绝不进入 watch 输入。这里只登记确切的文件路径：存在的进 fileDependencies，不存在的进
// missingDependencies——watcher 对 missing 路径的创建同样上报，「无锁文件的项目突然 install」
// 由此触发重编译。
//
// pnpm-lock.yaml 不一定在应用目录：workspace 成员的锁文件在 workspace 根。这里向上走：每个带
// package.json 的祖先目录都是潜在的锁文件位置，全部登记（存在与否各归各类），不猜哪一个才是
// 「真的」根。
export async function collectInstallSignalInputs(
  projectRoot: string,
): Promise<CompilerWatchInputs> {
  const fileDependencies: string[] = [];
  const missingDependencies: string[] = [];
  const register = async (path: string) => {
    ((await pathExists(path)) ? fileDependencies : missingDependencies).push(path);
  };
  await register(join(projectRoot, "package.json"));
  await register(join(projectRoot, "pnpm-lock.yaml"));
  for (let directory = dirname(projectRoot); ; directory = dirname(directory)) {
    if (await pathExists(join(directory, "package.json"))) {
      await register(join(directory, "pnpm-lock.yaml"));
    }
    if (dirname(directory) === directory) {
      return { fileDependencies, contextDependencies: [], missingDependencies };
    }
  }
}
