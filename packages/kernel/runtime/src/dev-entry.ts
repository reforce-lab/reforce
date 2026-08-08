import { type CrashTakeover, installCrashTakeover } from "@/crash-takeover";
import type { FrameworkLogging } from "@/framework-logging";
import { DevHmrManager, type RspackHmrRuntime } from "@/hmr-manager";
import type { Reporter } from "@/reporter";
import {
  installProcessShutdownHandlers,
  ShutdownController,
  type ShutdownFailure,
  type ShutdownResult,
  type ShutdownState,
} from "@/shutdown-controller";

export interface DevEntryOptions {
  readonly hot: RspackHmrRuntime;
  readonly bootstrap: () => Promise<{ close(): Promise<void> }>;
  readonly reporter: Reporter;
  readonly installProcessHandlers?: boolean;
}

export class DevEntryController {
  private readonly hmr: DevHmrManager;
  private readonly installHandlers: boolean;
  private readonly shutdown: ShutdownController;
  private readonly crash: CrashTakeover | undefined;
  private startPromise: Promise<void> | undefined;

  constructor(options: DevEntryOptions) {
    this.installHandlers = options.installProcessHandlers ?? true;
    this.shutdown = new ShutdownController({ command: "dev", reporter: options.reporter });
    // 开发态崩溃与生产同一套（RFC 0011 L6 把 HMR 明列为运行期框架输出）：此前 dev 完全没接，
    // 而开发态恰恰是崩溃最频繁的地方——裸 dump、引导缓冲照丢、关停全程静默。
    //
    // 跟 installProcessHandlers 同一个开关：那是既有的「本控制器可不可以碰进程」判据，
    // 进程内跑的用例（dev-runtime 的 harness）照旧一个 handler 都不装。
    this.crash = this.installHandlers
      ? installCrashTakeover({ command: "dev", reporter: options.reporter })
      : undefined;
    this.hmr = new DevHmrManager({
      hot: options.hot,
      bootstrap: options.bootstrap,
      onFatal: (error) => {
        void this.shutdown.requestShutdown({
          error,
          code: "HMR_FATAL",
          phase: "hmr",
          message: "Development HMR failed.",
        });
      },
    });
  }

  get finished(): Promise<ShutdownResult> {
    return this.shutdown.finished;
  }

  get state(): ShutdownState {
    return this.shutdown.state;
  }

  start(): Promise<void> {
    this.startPromise ??= this.startOnce();
    return this.startPromise;
  }

  checkForUpdates(): Promise<void> {
    return this.hmr.checkForUpdates();
  }

  requestShutdown(failure?: ShutdownFailure): Promise<ShutdownResult> {
    return this.shutdown.requestShutdown(failure);
  }

  // 每轮 bootstrap 之后都要重来一次：HMR 重载会换掉整个 bootstrap 模块，上一轮那个 logger
  // 的 sink 可能已经关了。attach 与 setLogger 都是覆盖写，重复调是安全的。
  attachLogging(logging: FrameworkLogging | undefined): void {
    if (logging === undefined) {
      return;
    }
    this.crash?.attach(logging);
    this.shutdown.setLogger(logging.logger);
  }

  private async startOnce(): Promise<void> {
    if (this.installHandlers) {
      installProcessShutdownHandlers(this.shutdown);
    } else {
      this.shutdown.setHandlerCleanup(() => undefined);
    }
    await this.shutdown.start(async () => {
      await this.hmr.start();
      return this.hmr;
    });
  }
}
