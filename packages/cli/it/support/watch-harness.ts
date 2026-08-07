import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DevCompilation } from "@/dev/watch-coordinator";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const workspaceRoot = resolve("../..");
const coreRoot = join(workspaceRoot, "packages", "core");
const radashiRoot = fileURLToPath(new URL("..", import.meta.resolve("radashi")));

export async function installContextDistribution(projectRoot: string): Promise<void> {
  const target = join(projectRoot, "node_modules", "@reforce", "core");
  await mkdir(target, { recursive: true });
  await Promise.all([
    cp(join(coreRoot, "package.json"), join(target, "package.json")),
    cp(join(coreRoot, "dist"), join(target, "dist"), { recursive: true }),
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
  while (true) {
    // 先记住已收到的次数再检查：检查期间到达的编译不能被当成「还没来」，否则会多等一次永远不会
    // 发生的重建。
    const received = compilations.all.length;
    if (await observed()) {
      return;
    }
    await compilations.untilCount(received + 1);
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

export interface InvalidationRecorder {
  readonly all: readonly (string | null)[];
  accept(path: string | null): void;
  untilPath(path: string): Promise<void>;
}

// 与 recordCompilations 同构：rspack 的 invalid 钩子本身就是事件，等它而不是轮询数组
// （轮询只留给没有事件可等的外部可观察物，见 tooling-testing 的 stall.ts）。
export function recordInvalidations(): InvalidationRecorder {
  const received: Array<string | null> = [];
  const waiters = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  return {
    get all() {
      return received;
    },
    accept(path) {
      received.push(path);
      if (path !== null) {
        waiters.get(path)?.resolve();
        waiters.delete(path);
      }
    },
    async untilPath(path) {
      if (received.includes(path)) {
        return;
      }
      const waiter = waiters.get(path) ?? Promise.withResolvers<void>();
      waiters.set(path, waiter);
      await waiter.promise;
    },
  };
}

// 哨兵重写的节奏钟：只控制「多久没等到就换 marker 重写」，不判失败——判死仍归包级
// `bun test --timeout` 击杀钟（Issue #92）。取值只需盖过 aggregateTimeout(200ms) + 一段余量。
const sentinelRetouchIntervalMilliseconds = 1_000;

// 事件流就绪屏障（Issue #177）：macOS 上 fs.watch 创建后 ≤10ms 窗口内的写入事件可能永久丢失
// （nodejs/node#52601，#86 探针实证），waitForRspackWatcher 的登记完成只证明初始扫描结束、
// 不证明事件流已就绪。真实用户从 dev 启动到首次保存隔着秒级，永远在窗口外；测试却是建完项目
// 毫秒级内首次编辑。这里在 Arrange 阶段对已在 watch 输入内的源文件追加 marker 注释（不改语义，
// 失败态项目同样适用），等 invalid 钩子报出该路径（「事件被投递」的直接证据，不依赖构建成败），
// 再等随后的编译回调把屏障自己的重建排干。哨兵写入自己可能正落在丢失窗口内——丢失是永久的，
// 重写是唯一自愈手段，停滞一个节奏钟就换新 marker 重写。
export async function establishWatchDelivery(input: {
  readonly compilations: CompilationRecorder;
  readonly invalidations: InvalidationRecorder;
  readonly sentinelPath: string;
  readonly sentinelBaseContent: string;
}): Promise<void> {
  // 先排干初始构建：它不是事件投递的证据（由 rsbuild.build 直接驱动），也不能让下面的
  // untilCount 把它误算成哨兵自己的重建。
  await input.compilations.untilCount(1);
  const delivered = input.invalidations.untilPath(input.sentinelPath);
  for (let attempt = 0; ; attempt += 1) {
    const received = input.compilations.all.length;
    await writeFile(
      input.sentinelPath,
      `${input.sentinelBaseContent}// watch-delivery-${attempt}\n`,
    );
    const arrived = await Promise.race([
      delivered.then(() => true),
      sleep(sentinelRetouchIntervalMilliseconds).then(() => false),
    ]);
    if (arrived) {
      await input.compilations.untilCount(received + 1);
      return;
    }
  }
}

export function watchesGeneratedOutput(
  projectRoot: string,
  invalidations: readonly (string | null)[],
): boolean {
  const generatedRoot = join(projectRoot, ".reforce");
  return invalidations.some((path) => path?.startsWith(generatedRoot));
}
