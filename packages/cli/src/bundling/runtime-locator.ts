import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 模块替换目标经标准 exports 解析定位（ADR 0009，#191）：import.meta.resolve 在 Node 下同步，
// 一套代码覆盖 workspace 测试、e2e 直跑 cli dist、发布安装三种形态；realpathSync 保证替换进
// rspack 模块图的是真实路径（#180 的 symlink-watch 教训），解析失败在 build 启动前抛出。
export function resolveRuntimeEntryPath(name: "dev-runtime" | "production-runtime"): string {
  return realpathSync(fileURLToPath(import.meta.resolve(`@reforce/runtime/${name}`)));
}
