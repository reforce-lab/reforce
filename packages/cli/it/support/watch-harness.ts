import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DevCompilation } from "@/dev/watch-coordinator";

const workspaceRoot = resolve("../..");
const contextRoot = join(workspaceRoot, "packages", "context");
const radashiRoot = fileURLToPath(new URL("..", import.meta.resolve("radashi")));

export async function installContextDistribution(projectRoot: string): Promise<void> {
  const target = join(projectRoot, "node_modules", "@reforce", "context");
  await mkdir(target, { recursive: true });
  await Promise.all([
    cp(join(contextRoot, "package.json"), join(target, "package.json")),
    cp(join(contextRoot, "dist"), join(target, "dist"), { recursive: true }),
    cp(radashiRoot, join(projectRoot, "node_modules", "radashi"), { recursive: true }),
  ]);
}

// 编译到达本来就是个事件（onCompilation 回调），所以这里等的是事件而不是时钟：不再有
// 「轮询 + 写死预算」这一层。旧实现用 Date.now() + 10_000 判死，那个数按快平台标定，
// windows 上正常但偏慢的编译会被判成失败（Issue #57）。
//
// 唯一剩下的时钟是包级 `bun test --timeout` 的击杀钟（Issue #92）。
export function recordCompilations(): {
  readonly all: readonly DevCompilation[];
  accept(compilation: DevCompilation): void;
  untilCount(count: number): Promise<void>;
} {
  const received: DevCompilation[] = [];
  const waiters = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  return {
    get all() {
      return received;
    },
    accept(compilation) {
      received.push(compilation);
      // 一次编译可能同时满足多个更小的门槛（例如 waiter 注册在 1，而这次直接到了 2）。
      for (const [threshold, waiter] of waiters) {
        if (received.length >= threshold) {
          waiter.resolve();
          waiters.delete(threshold);
        }
      }
    },
    async untilCount(count) {
      if (received.length >= count) {
        return;
      }
      const waiter = waiters.get(count) ?? Promise.withResolvers<void>();
      waiters.set(count, waiter);
      await waiter.promise;
    },
  };
}

export type CompilationRecorder = ReturnType<typeof recordCompilations>;

// 等的是「这次改动的效果已经出现」，不是「又编译了第几次」。watchpack 初始扫描按
// birthtime + FS_ACCURACY 判断目录在 watcher 启动前是否变过，而 FS_ACCURACY 从 2000ms 起、扫到带小数
// 毫秒的文件 mtime 才收窄；集成用例是建完临时项目立刻起 watcher，所以 <root>/src 会不会被额外报一次
// 变更、进而多出一次启动重建，取决于扫描顺序，是随机的。按次数等就会把那次噪声当成自己的重建，提前
// 断言（Issue #86）。真实用户不会在建完项目 300ms 内跑 dev，这条噪声只影响测试。
export async function untilObserved(
  compilations: CompilationRecorder,
  observed: () => Promise<boolean>,
): Promise<void> {
  // 临时诊断：macOS CI 上「编辑源文件」那条用例等满了整个预算，本地至今复现不出来。挂住时至少要能
  // 分清是「一次重建都没发生」还是「重建了但产物没反映改动」，否则失败信息只有一句 timed out
  // （Issue #86）。拿到一轮 CI 数据后删掉。
  const diagnostic = setInterval(() => {
    console.error(`[watch-diagnostic] compilations=${compilations.all.length}`);
  }, 15_000);
  try {
    while (true) {
      // 先记住已收到的次数再检查：检查期间到达的编译不能被当成「还没来」，否则会多等一次永远不会
      // 发生的重建。
      const received = compilations.all.length;
      if (await observed()) {
        return;
      }
      await compilations.untilCount(received + 1);
    }
  } finally {
    clearInterval(diagnostic);
  }
}

// 这个判定会在编译进行中被调用（写完源文件后立刻查一次），此时产物目录里可能有正在写的文件。读不到
// 就当作「还没出现」继续等下一次编译，不要把中间态当成失败。
export async function developmentOutputContains(
  devOutputRoot: string,
  marker: string,
): Promise<boolean> {
  const entries = await readdir(devOutputRoot, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const source = await readFile(join(entry.parentPath, entry.name), "utf8").catch(() => "");
    if (source.includes(marker)) {
      return true;
    }
  }
  return false;
}

export function watchesGeneratedOutput(
  projectRoot: string,
  invalidations: readonly (string | null)[],
): boolean {
  const generatedRoot = join(projectRoot, ".reforce");
  return invalidations.some((path) => path?.startsWith(generatedRoot));
}
