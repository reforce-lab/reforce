import type { CloseableApplication } from "@/runtime/shutdown-controller";

// The accept boundary lives in the generated development entry, not here: rspack only rewrites an
// accepted request into a module id when it sees the literal `import.meta.webpackHot.accept("...")`
// expression in the module that owns the hot object (Issue #46). Anything this side could call is
// keyed by a string no dependency matches, so the contract deliberately has no accept().
export interface RspackHmrRuntime {
  check(autoApply: false): Promise<false | null | readonly string[]>;
  apply(): Promise<unknown>;
}

export interface DevHmrManagerOptions {
  readonly hot: RspackHmrRuntime;
  readonly bootstrap: () => Promise<CloseableApplication>;
  readonly onFatal: (error: unknown) => void;
}

export class DevHmrManager implements CloseableApplication {
  private readonly bootstrap: () => Promise<CloseableApplication>;
  private readonly hot: RspackHmrRuntime;
  private readonly onFatal: (error: unknown) => void;
  private application: CloseableApplication | undefined;
  private closePromise: Promise<void> | undefined;
  private fatalNotified = false;
  private pendingCheck = false;
  private shuttingDown = false;
  private started = false;
  private updatePromise: Promise<void> | undefined;

  constructor(options: DevHmrManagerOptions) {
    this.bootstrap = options.bootstrap;
    this.hot = options.hot;
    this.onFatal = options.onFatal;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("The development HMR manager can only start once.");
    }
    this.started = true;
    this.application = await this.bootstrap();
    if (this.shuttingDown) {
      await this.close();
    }
    // No polling here on purpose. checkForUpdates() runs only when the parent reports a validated
    // build over IPC, which is the only moment the hot-update manifest is known to exist. Asking
    // on a timer meant asking before the first rebuild had ever happened, and the rspack HMR
    // runtime has no way back to "idle" once that download rejects (Issue #46).
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
    this.onFatal(error);
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
