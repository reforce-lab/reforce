import nodePath from "node:path";
import { isPathStrictlyContained, type PathSemantics } from "@reforce/primitives";
import type { ReforceCompilerGatePlugin } from "@/bundling/dev-gate-plugin";

// 「哪些目录不看」只允许有这一份定义：它同时喂给下面的 isProjectWatchFile 和 watchOptions.ignored。
// 两处以前各写各的，过滤器只比较 projectRoot 相对路径的首段、ignored 用的 `**/x/**` 却匹配任意深度，
// 于是 `<projectRoot>/packages/ui/dist/index.d.ts` 这类输入既通过过滤器又被 watcher 忽略，
// waitForRspackWatcher 永远等不到它，dev 启动 10 秒后判死（Issue #102）。
export const unwatchedDirectoryNames: readonly string[] = [
  ".reforce",
  ".git",
  "dist",
  "node_modules",
];

// 必须按**绝对路径**的整段判定，不能按 projectRoot 相对路径：watchpack 把 `**/x/**` 编译成锚在绝对
// 路径 `^` 的正则，projectRoot 自身路径里的 `dist` / `node_modules` 段一样会命中（Issue #102）。
//
// Exported only so the containment rule can be unit tested: reaching it through
// startDevWatchBuild needs a live rspack watcher, and the Windows cross-drive case cannot be
// produced on the runner at all. semantics is injectable for the same reason — a non-Windows
// runner has to be able to exercise win32 path rules; the default keeps callers unaware.
export function isProjectWatchFile(
  projectRoot: string,
  path: string,
  semantics: PathSemantics = nodePath,
): boolean {
  // Strict containment: projectRoot itself is a directory, never a watched file.
  if (!isPathStrictlyContained(projectRoot, path, semantics)) {
    return false;
  }
  const segments = path.split(semantics.sep);
  return !segments.some((segment) => unwatchedDirectoryNames.includes(segment));
}

// 每轮之间让出的时间。原实现用 setImmediate，那不是「等待」而是热自旋：它以 event loop 的循环
// 速度反复检查，实测本机空载 45ms 就绪要转 1000–5000 圈、满载 200ms 就绪要转 5000–21000 圈，
// 开销随等待时长线性膨胀，而烧掉的正是 watcher 自己的文件系统回调所需要的 CPU。定时轮询把它
// 降到个位数次，代价是就绪检测最多晚一个间隔（Issue #83）。
const watcherPollIntervalMilliseconds = 10;

// 判死的依据是「不再有进展」，不是「花了多久」。原实现用固定 5 秒总预算，那个数按开发机速度
// 标定：项目更大、机器更慢、或同时跑多个 dev 时，watcher 只是还没登记完就被判成永远不会就绪，
// 用户会拿到一个假的失败（Issue #83）。已登记数还在增长就说明它在干活，继续等；只有停滞超过
// 下面这个窗口才说明真的卡住了。等待上限因此自动随项目规模伸缩，与平台速度无关。
const watcherProgressStallBudgetMilliseconds = 10_000;

// startDevWatchBuild must not resolve until the rspack watcher has registered every gate watch
// input in fileTimeInfoEntries; that invariant guarantees a file modification made immediately
// after startup triggers a rebuild instead of being silently missed.
export async function waitForRspackWatcher(
  plugin: ReforceCompilerGatePlugin,
  projectRoot: string,
): Promise<void> {
  let lastProgress = "";
  let lastProgressAt = Date.now();
  while (true) {
    const projectFiles =
      plugin.current?.watchInputs.fileDependencies.filter((path) =>
        isProjectWatchFile(projectRoot, path),
      ) ?? [];
    // getInfo() 每次都会重建整张表，一轮只取一次。
    const registeredFiles = plugin.compiler?.watching?.watcher?.getInfo().fileTimeInfoEntries;
    const registered =
      registeredFiles === undefined
        ? 0
        : projectFiles.filter((path) => registeredFiles.has(path)).length;
    if (projectFiles.length > 0 && registered === projectFiles.length) {
      return;
    }
    // watchInputs 自己也可能还在增长，所以「有进展」要同时看已登记数和待登记总数。
    const progress = `${registered}/${projectFiles.length}`;
    if (progress !== lastProgress) {
      lastProgress = progress;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt >= watcherProgressStallBudgetMilliseconds) {
      throw new Error("Development filesystem watcher stopped making progress.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, watcherPollIntervalMilliseconds));
  }
}
