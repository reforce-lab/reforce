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

export class DevChildSupervisor {
  readonly #onChildFailure: (failure: DevChildExit) => void;
  readonly #onNaturalExit: () => void;
  readonly #onTerminalFailure: (failure: DevChildExit) => void;
  readonly #spawn: (buildId: string) => Promise<ManagedDevChild>;
  #child: ManagedDevChild | undefined;
  #completed = false;
  #currentBuildId: string | undefined;
  #queue = Promise.resolve();
  #restartCount = 0;
  #shutdownPromise: Promise<void> | undefined;
  #shuttingDown = false;

  constructor(options: DevChildSupervisorOptions) {
    this.#spawn = options.spawn;
    this.#onChildFailure = options.onChildFailure ?? (() => undefined);
    this.#onTerminalFailure = options.onTerminalFailure ?? (() => undefined);
    this.#onNaturalExit = options.onNaturalExit ?? (() => undefined);
  }

  get currentBuildId(): string | undefined {
    return this.#currentBuildId;
  }

  get hasLiveChild(): boolean {
    return this.#child !== undefined;
  }

  get restartCount(): number {
    return this.#restartCount;
  }

  acceptSuccessfulBuild(buildId: string): Promise<void> {
    if (buildId.length === 0) {
      return Promise.reject(new Error("A successful development build requires an ID."));
    }
    return this.#enqueue(async () => {
      if (this.#shuttingDown || this.#completed) {
        return;
      }
      const buildChanged = this.#currentBuildId !== buildId;
      if (buildChanged) {
        this.#currentBuildId = buildId;
        this.#restartCount = 0;
      }
      if (this.#child) {
        return;
      }
      if (!buildChanged && this.#restartCount >= 1) {
        return;
      }
      await this.#spawnCurrentBuild();
    });
  }

  acceptBuildFailure(): Promise<void> {
    return this.#enqueue(async () => undefined);
  }

  shutdown(signal?: NodeJS.Signals): Promise<void> {
    if (this.#shutdownPromise) {
      return this.#shutdownPromise;
    }
    this.#shutdownPromise = this.#enqueue(async () => {
      this.#shuttingDown = true;
      const child = this.#child;
      if (!child) {
        return;
      }
      await child.requestShutdown(signal);
      await child.exited;
      if (this.#child === child) {
        this.#child = undefined;
      }
    });
    return this.#shutdownPromise;
  }

  async whenIdle(): Promise<void> {
    await Promise.resolve();
    await this.#queue;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #spawnCurrentBuild(): Promise<void> {
    const buildId = this.#currentBuildId;
    if (!buildId || this.#child || this.#shuttingDown || this.#completed) {
      return;
    }
    let child: ManagedDevChild;
    try {
      child = await this.#spawn(buildId);
    } catch (error) {
      await this.#handleChildFailure({ exitCode: null, error });
      return;
    }
    if (this.#shuttingDown) {
      await child.requestShutdown();
      await child.exited;
      return;
    }
    this.#child = child;
    void child.exited.then(
      (exit) => this.#enqueue(() => this.#handleChildExit(child, exit)),
      (error: unknown) =>
        this.#enqueue(() => this.#handleChildExit(child, { exitCode: null, error })),
    );
  }

  async #handleChildExit(child: ManagedDevChild, exit: DevChildExit): Promise<void> {
    if (this.#child !== child) {
      return;
    }
    this.#child = undefined;
    if (this.#shuttingDown) {
      return;
    }
    if (exit.exitCode === 0) {
      this.#completed = true;
      this.#onNaturalExit();
      return;
    }
    await this.#handleChildFailure(exit);
  }

  async #handleChildFailure(failure: DevChildExit): Promise<void> {
    this.#onChildFailure(failure);
    if (this.#restartCount >= 1 || !this.#currentBuildId || this.#shuttingDown) {
      if (this.#restartCount >= 1 && this.#currentBuildId && !this.#shuttingDown) {
        this.#onTerminalFailure(failure);
      }
      return;
    }
    this.#restartCount += 1;
    await this.#spawnCurrentBuild();
  }
}
