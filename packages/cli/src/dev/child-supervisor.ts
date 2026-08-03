export interface DevChildExit {
  readonly exitCode: number | null;
  readonly signalName?: string;
  readonly error?: unknown;
}

export interface ManagedDevChild {
  readonly exited: Promise<DevChildExit>;
  requestShutdown(signal?: NodeJS.Signals): Promise<void>;
}

export interface DevChildSupervisorOptions {
  readonly spawn: (buildId: string) => Promise<ManagedDevChild>;
  readonly onChildFailure?: (failure: DevChildExit) => void;
  readonly onTerminalFailure?: (failure: DevChildExit) => void;
  readonly onNaturalExit?: () => void;
}

const maximumRestartsPerBuild = 1;

export class DevChildSupervisor {
  private readonly onChildFailure: (failure: DevChildExit) => void;
  private readonly onNaturalExit: () => void;
  private readonly onTerminalFailure: (failure: DevChildExit) => void;
  private readonly spawn: (buildId: string) => Promise<ManagedDevChild>;
  private child: ManagedDevChild | undefined;
  private completed = false;
  private currentBuildIdValue: string | undefined;
  private queue = Promise.resolve();
  private restartCountValue = 0;
  private shutdownPromise: Promise<void> | undefined;
  private shuttingDown = false;

  constructor(options: DevChildSupervisorOptions) {
    this.spawn = options.spawn;
    this.onChildFailure = options.onChildFailure ?? (() => undefined);
    this.onTerminalFailure = options.onTerminalFailure ?? (() => undefined);
    this.onNaturalExit = options.onNaturalExit ?? (() => undefined);
  }

  get currentBuildId(): string | undefined {
    return this.currentBuildIdValue;
  }

  get hasLiveChild(): boolean {
    return this.child !== undefined;
  }

  get restartCount(): number {
    return this.restartCountValue;
  }

  acceptSuccessfulBuild(buildId: string): Promise<void> {
    if (buildId.length === 0) {
      return Promise.reject(new Error("A successful development build requires an ID."));
    }
    return this.enqueue(async () => {
      if (this.shuttingDown || this.completed) {
        return;
      }
      const buildChanged = this.currentBuildIdValue !== buildId;
      if (buildChanged) {
        this.currentBuildIdValue = buildId;
        this.restartCountValue = 0;
      }
      if (this.child) {
        return;
      }
      if (!buildChanged && this.restartCountValue >= maximumRestartsPerBuild) {
        return;
      }
      await this.spawnCurrentBuild();
    });
  }

  // A failed build needs no supervisor action of its own; enqueueing an empty step keeps the
  // returned promise behind any in-flight spawn or shutdown so callers settle events in order.
  acceptBuildFailure(): Promise<void> {
    return this.enqueue(async () => undefined);
  }

  shutdown(signal?: NodeJS.Signals): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shutdownPromise = this.enqueue(async () => {
      this.shuttingDown = true;
      const child = this.child;
      if (!child) {
        return;
      }
      await child.requestShutdown(signal);
      await child.exited;
      if (this.child === child) {
        this.child = undefined;
      }
    });
    return this.shutdownPromise;
  }

  async whenIdle(): Promise<void> {
    await Promise.resolve();
    await this.queue;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async spawnCurrentBuild(): Promise<void> {
    const buildId = this.currentBuildIdValue;
    if (!buildId || this.child || this.shuttingDown || this.completed) {
      return;
    }
    let child: ManagedDevChild;
    try {
      child = await this.spawn(buildId);
    } catch (error) {
      await this.handleChildFailure({ exitCode: null, error });
      return;
    }
    if (this.shuttingDown) {
      await child.requestShutdown();
      await child.exited;
      return;
    }
    this.child = child;
    void child.exited.then(
      (exit) => this.enqueue(() => this.handleChildExit(child, exit)),
      (error: unknown) =>
        this.enqueue(() => this.handleChildExit(child, { exitCode: null, error })),
    );
  }

  private async handleChildExit(child: ManagedDevChild, exit: DevChildExit): Promise<void> {
    if (this.child !== child) {
      return;
    }
    this.child = undefined;
    if (this.shuttingDown) {
      return;
    }
    if (exit.exitCode === 0) {
      this.completed = true;
      this.onNaturalExit();
      return;
    }
    await this.handleChildFailure(exit);
  }

  private async handleChildFailure(failure: DevChildExit): Promise<void> {
    this.onChildFailure(failure);
    const restartBudgetExhausted = this.restartCountValue >= maximumRestartsPerBuild;
    if (!restartBudgetExhausted && this.currentBuildIdValue && !this.shuttingDown) {
      this.restartCountValue += 1;
      await this.spawnCurrentBuild();
      return;
    }
    if (restartBudgetExhausted && this.currentBuildIdValue && !this.shuttingDown) {
      this.onTerminalFailure(failure);
    }
  }
}
