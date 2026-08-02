import { BeanResolver } from "#internal/bean-resolver";
import {
  ApplicationCleanupError,
  ApplicationContextStateError,
  ApplicationStartError,
  type CleanupActionError,
  InvalidGeneratedDefinitionError,
} from "#internal/errors";
import type { GeneratedApplicationDefinition } from "#internal/generated-contracts";
import { LifecycleRunner } from "#internal/lifecycle-runner";
import type {
  ApplicationContext,
  BeanClass,
  BeanDefinition,
  ContextOperation,
} from "#internal/public-types";
import { ResolutionState } from "#internal/resolution-state";

export class RuntimeApplicationContext implements ApplicationContext {
  readonly #state: ResolutionState;
  readonly #resolver: BeanResolver;
  readonly #lifecycle: LifecycleRunner;

  constructor(definition: GeneratedApplicationDefinition) {
    this.#state = new ResolutionState(definition);
    this.#resolver = new BeanResolver(this.#state);
    this.#lifecycle = new LifecycleRunner(this.#state);
  }

  start(): Promise<void> {
    if (this.#state.contextState !== "created") {
      return Promise.reject(this.#stateError("start"));
    }
    this.#state.contextState = "starting";
    this.#state.startPromise = Promise.resolve().then(() => this.#runStart());
    return this.#state.startPromise;
  }

  get<T extends object>(target: BeanClass<T> | BeanDefinition<T>): T {
    if (this.#state.contextState !== "running") {
      throw this.#stateError("get");
    }
    return this.#resolver.get(target);
  }

  close(): Promise<void> {
    if (this.#state.closePromise) {
      return this.#state.closePromise;
    }
    if (this.#state.contextState === "starting") {
      this.#state.requestClose();
      this.#state.closePromise = this.#waitForStartBoundaryAndCleanup();
      return this.#state.closePromise;
    }
    if (
      this.#state.contextState === "created" ||
      this.#state.contextState === "running" ||
      this.#state.contextState === "failed"
    ) {
      this.#state.contextState = "closing";
    }
    this.#state.closePromise = this.#observeCleanup(this.#beginCleanup());
    return this.#state.closePromise;
  }

  async #runStart(): Promise<void> {
    try {
      for (const id of this.#state.definition.plans.constructionOrder) {
        this.#resolver.construct(id);
      }
      await this.#lifecycle.runStartActions();
      if (this.#state.closeRequested) {
        this.#state.contextState = "closing";
        this.#beginCleanup();
        return;
      }
      this.#state.contextState = "running";
    } catch (error) {
      const startupError = this.#resolver.normalizeStartupError(error);
      this.#state.contextState = "failed";
      const cleanupPromise = this.#beginCleanup();
      this.#ensureRollbackClosePromise(cleanupPromise);
      let cleanupErrors: readonly CleanupActionError[] = [];
      try {
        await cleanupPromise;
      } catch (cleanupError) {
        if (cleanupError instanceof ApplicationCleanupError) {
          cleanupErrors = cleanupError.errors;
        } else {
          throw cleanupError;
        }
      }
      throw new ApplicationStartError({ cause: startupError, errors: cleanupErrors });
    }
  }

  async #waitForStartBoundaryAndCleanup(): Promise<void> {
    try {
      await this.#state.startPromise;
    } catch {
      return await this.#requireCleanupPromise();
    }
    return await this.#requireCleanupPromise();
  }

  #ensureRollbackClosePromise(cleanupPromise: Promise<void>): void {
    if (!this.#state.closePromise) {
      this.#state.closePromise = this.#observeCleanup(cleanupPromise);
    }
  }

  #observeCleanup(cleanupPromise: Promise<void>): Promise<void> {
    return cleanupPromise.then(
      () => undefined,
      (error: unknown) => Promise.reject(error),
    );
  }

  #requireCleanupPromise(): Promise<void> {
    return (
      this.#state.cleanupPromise ??
      Promise.reject(
        new InvalidGeneratedDefinitionError(
          "Context reached a close boundary without a cleanup result.",
        ),
      )
    );
  }

  #beginCleanup(): Promise<void> {
    if (this.#state.cleanupPromise) {
      return this.#state.cleanupPromise;
    }
    if (this.#state.contextState !== "closing") {
      this.#state.contextState = "closing";
    }
    this.#state.cleanupPromise = Promise.resolve()
      .then(() => this.#lifecycle.runCleanup())
      .finally(() => {
        this.#state.contextState = "closed";
      });
    return this.#state.cleanupPromise;
  }

  #stateError(operation: ContextOperation): ApplicationContextStateError {
    return new ApplicationContextStateError({ operation, state: this.#state.contextState });
  }
}
