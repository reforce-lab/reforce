import { type BootstrapLogBuffer, createBootstrapLogBuffer } from "@/bootstrap-buffer";
import type { Logger, LoggerFactory, LogLevel } from "@/contracts";

// 进程级引导注册表（RFC 0011 L7，#249）。
//
// 绑定 bean 存在之前就有话要说——@reforce/config 的绑定 phase 跑在**一切 bean 构造之前**
// （ADR 0005 决策 6.1），那一刻容器里还没有 LoggerFactory。这些早期记录没有别的地方可去，
// 只能先攒进一个进程级缓冲。
//
// 为什么是进程级单例而不是依赖注入：需要它的代码（配置绑定）正是「容器还不存在」的那段，
// 拿不到任何注入点。这是单例唯一说得通的场合，不是图省事。
//
// **绝不静默丢弃**是硬约束：缓冲里的记录在绑定失败时是唯一的现场。所以第一条记录进来时就
// 惰性挂一个 exit 兜底——没人重放的话，退出前按 short 形态吐 stderr。不写日志的应用一条记录
// 也不会有，因此这个 handler 永远不会被挂上，零开销。

let buffer: BootstrapLogBuffer | undefined;
let fallbackInstalled = false;
let replayed = false;

function installExitFallback(): void {
  if (fallbackInstalled) {
    return;
  }
  fallbackInstalled = true;
  // exit 回调里只能同步写，drainToStderr 用的正是同步 write。
  process.once("exit", () => {
    if (replayed) {
      return;
    }
    buffer?.drainToStderr();
  });
}

function ensureBuffer(): BootstrapLogBuffer {
  buffer ??= createBootstrapLogBuffer();
  installExitFallback();
  return buffer;
}

/**
 * 引导期 logger：容器就绪之前唯一能用的写日志入口。
 *
 * 拿到的句柄在重放之后仍然可用——它会转发给真 logger，而不是继续攒（继续攒的记录再也不会
 * 被重放）。所以调用方可以在模块作用域里取一次、一直用。
 */
export function bootstrapLogger(name: string): Logger {
  return ensureBuffer().logger(name);
}

/**
 * 把引导期攒下的记录按原始时间戳重放进真正的绑定，并让引导 logger 退场。
 *
 * 由拿得到 LoggerFactory 的一方调用——通常是应用启动代码在容器 start 之后。不调也不会丢：
 * exit 兜底会把它们吐到 stderr，只是少了用户配置的格式与目标。
 */
export function replayBootstrapLogs(factory: LoggerFactory): void {
  if (buffer === undefined || replayed) {
    return;
  }
  replayed = true;
  buffer.replayInto((name) => factory.create(name));
}

/**
 * 绑定构造失败时的最后手段：把攒下的记录按 short 形态吐到 stderr（不变量 9，绝不静默丢弃）。
 *
 * exit 兜底已经覆盖「进程就此退出」这一种，但那条路要等到退出时刻，而且只在真的退出时才走。
 * 启动失败的调用方通常还要往上抛、还要打自己的错误——那些输出会排在缓冲之前，把因果顺序
 * 颠倒过来。所以失败路径显式调这一条，让现场先出来。重复调是安全的：缓冲已被排空。
 */
export function drainBootstrapLogs(): void {
  buffer?.drainToStderr();
}

/** 已攒下、尚未重放的记录条数因缓冲溢出而丢弃的数量。 */
export function droppedBootstrapRecords(): number {
  return buffer?.droppedCount() ?? 0;
}

// 仅测试用：进程级单例在同一个测试文件里会跨用例串味。
export function resetBootstrapRegistryForTest(
  options: { readonly threshold?: LogLevel } = {},
): void {
  buffer = createBootstrapLogBuffer(
    options.threshold === undefined ? {} : { threshold: options.threshold },
  );
  replayed = false;
}
