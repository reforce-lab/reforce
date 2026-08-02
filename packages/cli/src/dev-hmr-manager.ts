import type { CloseableApplication } from "@/shutdown-controller";

export const applicationBootstrapSpecifier = "reforce:application-bootstrap";

export interface RspackHmrRuntime {
  accept(specifier: typeof applicationBootstrapSpecifier): void;
  check(autoApply: false): Promise<false | null | readonly string[]>;
  apply(): Promise<unknown>;
}

export interface DevTimerScheduler {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(timer: unknown): void;
}

export interface DevHmrManagerOptions {
  readonly hot: RspackHmrRuntime;
  readonly bootstrap: () => Promise<CloseableApplication>;
  readonly onFatal: (error: unknown) => void;
  readonly scheduler?: DevTimerScheduler;
}

const pollingIntervalMilliseconds = 250;

const defaultScheduler: DevTimerScheduler = {
  setInterval(callback, milliseconds) {
    const timer = setInterval(callback, milliseconds);
    timer.unref();
    return timer;
  },
  clearInterval(timer) {
    clearInterval(timer as ReturnType<typeof setInterval>); // Only this scheduler creates the opaque timer value.
  },
};

export class DevHmrManager implements CloseableApplication {
  private readonly bootstrap: () => Promise<CloseableApplication>;
  private readonly hot: RspackHmrRuntime;
  private readonly onFatal: (error: unknown) => void;
  private readonly scheduler: DevTimerScheduler;
  private application: CloseableApplication | undefined;
  private closePromise: Promise<void> | undefined;
  private fatalNotified = false;
  private pendingCheck = false;
  private shuttingDown = false;
  private started = false;
  private timer: unknown;
  private updatePromise: Promise<void> | undefined;

  constructor(options: DevHmrManagerOptions) {
    this.bootstrap = options.bootstrap;
    this.hot = options.hot;
    this.onFatal = options.onFatal;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("The development HMR manager can only start once.");
    }
    this.started = true;
    this.hot.accept(applicationBootstrapSpecifier);
    this.application = await this.bootstrap();
    if (this.shuttingDown) {
      await this.close();
      return;
    }
    this.timer = this.scheduler.setInterval(() => {
      if (this.shuttingDown) {
        return;
      }
      void this.checkForUpdates().catch(() => undefined);
    }, pollingIntervalMilliseconds);
  }

  checkForUpdates(): Promise<void> {
    if (this.shuttingDown) {
      return Promise.resolve();
    }
    if (!this.started || !this.application) {
      return Promise.reject(new Error("The development HMR manager is not running."));
    }
    if (this.updatePromise) {
      this.pendingCheck = true;
      return this.updatePromise;
    }
    this.updatePromise = this.runUpdateLoop()
      .catch((error: unknown) => {
        this.beginFatal(error);
        throw error;
      })
      .finally(() => {
        this.updatePromise = undefined;
      });
    return this.updatePromise;
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.shuttingDown = true;
    this.clearTimer();
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private async runUpdateLoop(): Promise<void> {
    do {
      this.pendingCheck = false;
      const outdatedModules = await this.hot.check(false);
      if (!outdatedModules) {
        continue;
      }
      const previousApplication = this.application;
      if (!previousApplication) {
        throw new Error("The current development application is unavailable.");
      }
      await previousApplication.close();
      if (this.application === previousApplication) {
        this.application = undefined;
      }
      await this.hot.apply();
      this.application = await this.bootstrap();
    } while (this.pendingCheck && !this.shuttingDown);
  }

  private beginFatal(error: unknown): void {
    if (this.fatalNotified) {
      return;
    }
    this.fatalNotified = true;
    this.shuttingDown = true;
    this.clearTimer();
    this.onFatal(error);
  }

  private clearTimer(): void {
    if (this.timer === undefined) {
      return;
    }
    this.scheduler.clearInterval(this.timer);
    this.timer = undefined;
  }

  private async finishClose(): Promise<void> {
    try {
      await this.updatePromise;
    } catch {
      // The fatal error is owned by the shared shutdown controller.
    }
    await this.application?.close();
  }
}
