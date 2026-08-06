import { type CliCommandName, createFailureEvent, type Reporter } from "@/reporter";
import { withTimeout } from "@/with-timeout";

// 崩溃接管（RFC 0011 C2，#250）。装了 uncaughtException handler 就等于接管了 Node 的默认
// 行为，而默认行为是「打整条栈 + 退出码 1」——所以这里必须把两半都还回去，退出码语义一个字
// 都不能变。
//
// 不走 ShutdownController，尽管计划书原话是「装在 installProcessShutdownHandlers 旁边」：
// 它的 performShutdown 第一行就 detachHandlers()，优雅关停一开始，经 setHandlerCleanup 装的
// handler 全被摘掉，而崩溃恰恰可能发生在那之后；它的 requestShutdown 只在 "running" 态动作，
// 引导期崩溃交给它等于把崩溃吞掉。两条都是「静默」，正是不变量 9 要禁的。

// 消费侧自己声明的最小形状：@reforce/logging 反过来依赖 @reforce/runtime，import 它（哪怕
// 只是 type-only，那也会留在生成的 d.ts 里）就是一个包循环。
type LogFields = Readonly<Record<string, unknown>> | undefined;

export interface FatalLogger {
  fatal(fields: LogFields, message: string): void;
}

export interface FlushableLoggerFactory {
  // 可选就是「排空是可选的」的表达方式：同步写的绑定没有可排空的东西，硬声明一个恒 resolve
  // 的方法只会让「这个绑定到底会不会丢日志」变得看不出来。
  flush?(): Promise<void>;
}

// 崩溃接管用得到的两半。production-runtime 交进来的 FrameworkLogging 结构性满足它，且比它
// 宽（关停日志还要 info）——每个消费者只声明自己用得到的部分，这是本仓既定做法。
export interface CrashLogTarget {
  readonly logger: FatalLogger;
  readonly factory: FlushableLoggerFactory;
}

// 进程是外部边界，做成可替身的缝（同 default-logger 的 write/now 惯例）。
interface CrashProcess {
  on(event: "uncaughtException", handler: CrashHandler): void;
  off(event: "uncaughtException", handler: CrashHandler): void;
  exit(code: number): never;
  exitCode: number | string | null | undefined;
  stderr: { write(chunk: string): unknown };
}

type CrashHandler = (error: unknown, origin: NodeJS.UncaughtExceptionOrigin) => void;

const crashMessages = {
  uncaughtException: "uncaught exception",
  unhandledRejection: "unhandled rejection",
} as const satisfies Record<NodeJS.UncaughtExceptionOrigin, string>;

// 排空预算。给死的而不是给旋钮：没人要过可配置的崩溃排空时间，而超时的后果（放弃排空直接
// 退出）本来就不该由调用方调。
const flushBudgetMilliseconds = 2_000;

export interface CrashTakeoverOptions {
  readonly command: CliCommandName;
  readonly reporter: Reporter;
  readonly process?: CrashProcess;
}

export interface CrashTakeover {
  attach(logging: CrashLogTarget | undefined): void;
  uninstall(): void;
}

// 真 process 的 on/off 重载与 exitCode 的可写性凑不出 CrashProcess 的精确形状，所以显式
// 转接一层而不是断言——转接是可读的，断言只是把不一致藏起来。
function nodeProcess(): CrashProcess {
  return {
    on: (event, handler) => {
      process.on(event, handler);
    },
    off: (event, handler) => {
      process.off(event, handler);
    },
    exit: (code) => process.exit(code),
    get exitCode() {
      return process.exitCode;
    },
    set exitCode(value) {
      process.exitCode = value;
    },
    stderr: process.stderr,
  };
}

function stackOf(error: unknown): string {
  // 栈整条打出去，不做栈帧过滤：这个仓里没有任何栈帧过滤设施，为崩溃路径单造一套等于把
  // 一个新机制塞进错误的包（它同样得服务 renderHumanFailure）。
  return error instanceof Error && typeof error.stack === "string" ? error.stack : String(error);
}

class ProcessCrashTakeover implements CrashTakeover {
  private readonly command: CliCommandName;
  private readonly reporter: Reporter;
  private readonly host: CrashProcess;
  private readonly handler: CrashHandler;
  private logging: CrashLogTarget | undefined;
  private crashing = false;

  constructor(options: CrashTakeoverOptions) {
    this.command = options.command;
    this.reporter = options.reporter;
    this.host = options.process ?? nodeProcess();
    this.handler = (error, origin) => this.onCrash(error, origin);
    // 只装 uncaughtException：没有 unhandledRejection 监听器时，未处理的 rejection 会以
    // origin === "unhandledRejection" 送到这里。两个都装反而要多一套去重。
    this.host.on("uncaughtException", this.handler);
  }

  attach(logging: CrashLogTarget | undefined): void {
    // 崩溃已经开始就不再改去处：bootstrap 可能比第一次崩溃晚完成，中途换目标会让排空写到
    // 半个 sink 上。
    if (this.crashing) {
      return;
    }
    this.logging = logging;
  }

  uninstall(): void {
    this.host.off("uncaughtException", this.handler);
  }

  private onCrash(error: unknown, origin: NodeJS.UncaughtExceptionOrigin): void {
    if (this.crashing) {
      // 第二次崩溃不重启排空、也不 exit——那会把第一现场截断。但也不能静默（不变量 9）。
      this.host.stderr.write(
        `[reforce] a second crash arrived while the first was still being flushed: ${stackOf(error)}\n`,
      );
      return;
    }
    this.crashing = true;
    // 同步置位，在任何 await 之前：withTimeout 的定时器是 unref 的，崩溃时可能一个 ref 住的
    // 句柄都没有，event loop 排空后进程会自己退出，跑不到下面那句 exit(1)。不先置位的话
    // 那种情况下退出码会是 0，「退出码语义不变」就破了。
    this.host.exitCode = 1;
    void this.takeOver(error, origin);
  }

  private async takeOver(error: unknown, origin: NodeJS.UncaughtExceptionOrigin): Promise<void> {
    this.writeRecord(error, origin);
    try {
      // Promise.resolve 包一层：flush 缺席时是 undefined，也要照样吃掉超时预算的计时。
      await withTimeout(
        Promise.resolve(this.logging?.factory.flush?.()),
        flushBudgetMilliseconds,
        "Crash log flush timed out.",
      );
    } catch {
      // 排空失败不能挡住退出。现场已经交给 logger 了，能不能落盘是次要的。
    }
    await this.reporter.flush().catch(() => undefined);
    this.host.exit(1);
  }

  private writeRecord(error: unknown, origin: NodeJS.UncaughtExceptionOrigin): void {
    const logger = this.logging?.logger;
    if (logger === undefined) {
      this.reportFallback(error, origin);
      return;
    }
    try {
      // err 是保留字段名，栈由 logger 自己的序列化器带出去，这里不做任何加工。
      logger.fatal({ err: error, origin }, crashMessages[origin]);
    } catch (loggingFailure) {
      this.reportFallback(error, origin, loggingFailure);
    }
  }

  private reportFallback(
    error: unknown,
    origin: NodeJS.UncaughtExceptionOrigin,
    loggingFailure?: unknown,
  ): void {
    this.reporter.report(
      createFailureEvent({
        command: this.command,
        phase: "crash",
        fallbackCode: "UNCAUGHT_EXCEPTION",
        message: crashMessages[origin],
        cause:
          loggingFailure === undefined
            ? error
            : new AggregateError([loggingFailure, error], "The crash logger itself failed.", {
                cause: loggingFailure,
              }),
      }),
    );
    // 人读渲染只打消息与 cause 链，不打栈。裸 stderr 把栈补回来——装 handler 之前 Node 打的
    // 就是它，接管了就得还回去。
    this.host.stderr.write(`${stackOf(error)}\n`);
  }
}

export function installCrashTakeover(options: CrashTakeoverOptions): CrashTakeover {
  return new ProcessCrashTakeover(options);
}
