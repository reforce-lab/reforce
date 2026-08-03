import type { Reporter } from "@/reporter";
import {
  DevHmrManager,
  type DevTimerScheduler,
  type RspackHmrRuntime,
} from "@/runtime/hmr-manager";
import {
  installProcessShutdownHandlers,
  ShutdownController,
  type ShutdownFailure,
  type ShutdownResult,
  type ShutdownState,
} from "@/runtime/shutdown-controller";

export interface DevEntryOptions {
  readonly hot: RspackHmrRuntime;
  readonly bootstrap: () => Promise<{ close(): Promise<void> }>;
  readonly reporter: Reporter;
  readonly scheduler?: DevTimerScheduler;
  readonly installProcessHandlers?: boolean;
}

export class DevEntryController {
  private readonly hmr: DevHmrManager;
  private readonly installHandlers: boolean;
  private readonly shutdown: ShutdownController;
  private startPromise: Promise<void> | undefined;

  constructor(options: DevEntryOptions) {
    this.installHandlers = options.installProcessHandlers ?? true;
    this.shutdown = new ShutdownController({ command: "dev", reporter: options.reporter });
    this.hmr = new DevHmrManager({
      hot: options.hot,
      bootstrap: options.bootstrap,
      scheduler: options.scheduler,
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
