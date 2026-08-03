import { BeanResolver } from "@/bean-resolver";
import {
  ApplicationCleanupError,
  ApplicationContextStateError,
  ApplicationStartError,
  type CleanupActionError,
  InvalidGeneratedDefinitionError,
} from "@/errors";
import type { GeneratedApplicationDefinition } from "@/generated-contracts";
import { LifecycleRunner } from "@/lifecycle-runner";
import type {
  ApplicationContext,
  BeanClass,
  BeanDefinition,
  ContextOperation,
} from "@/public-types";
import { ResolutionState } from "@/resolution-state";

export class RuntimeApplicationContext implements ApplicationContext {
  private readonly state: ResolutionState;
  private readonly resolver: BeanResolver;
  private readonly lifecycle: LifecycleRunner;

  constructor(definition: GeneratedApplicationDefinition) {
    this.state = new ResolutionState(definition);
    this.resolver = new BeanResolver(this.state);
    this.lifecycle = new LifecycleRunner(this.state);
  }

  start(): Promise<void> {
    if (this.state.contextState !== "created") {
      return Promise.reject(this.stateError("start"));
    }
    this.state.contextState = "starting";
    this.state.startPromise = Promise.resolve().then(() => this.runStart());
    return this.state.startPromise;
  }

  get<T extends object>(target: BeanClass<T> | BeanDefinition<T>): T {
    if (this.state.contextState !== "running") {
      throw this.stateError("get");
    }
    return this.resolver.get(target);
  }

  close(): Promise<void> {
    if (this.state.closePromise) {
      return this.state.closePromise;
    }
    if (this.state.contextState === "starting") {
      this.state.requestClose();
      this.state.closePromise = this.waitForStartBoundaryAndCleanup();
      return this.state.closePromise;
    }
    // Reaching here with no closePromise means the state is created/running/failed:
    // every transition to closing/closed sets closePromise in the same synchronous
    // segment, and starting is handled above.
    this.state.contextState = "closing";
    this.state.closePromise = this.beginCleanup();
    return this.state.closePromise;
  }

  private async runStart(): Promise<void> {
    try {
      for (const id of this.state.definition.plans.constructionOrder) {
        this.resolver.construct(id);
      }
      await this.lifecycle.runStartActions();
      if (this.state.closeRequested) {
        this.state.contextState = "closing";
        this.beginCleanup();
        return;
      }
      this.state.contextState = "running";
    } catch (error) {
      const startupError = this.resolver.normalizeStartupError(error);
      this.state.contextState = "failed";
      const cleanupPromise = this.beginCleanup();
      this.ensureRollbackClosePromise(cleanupPromise);
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

  private async waitForStartBoundaryAndCleanup(): Promise<void> {
    try {
      await this.state.startPromise;
    } catch {
      // A failed start already runs its own rollback cleanup, so both outcomes
      // join here: the close boundary is the cleanup result, not the start result.
    }
    return await this.requireCleanupPromise();
  }

  private ensureRollbackClosePromise(cleanupPromise: Promise<void>): void {
    if (!this.state.closePromise) {
      this.state.closePromise = cleanupPromise;
    }
  }

  private requireCleanupPromise(): Promise<void> {
    return (
      this.state.cleanupPromise ??
      Promise.reject(
        new InvalidGeneratedDefinitionError(
          "Context reached a close boundary without a cleanup result.",
        ),
      )
    );
  }

  private beginCleanup(): Promise<void> {
    if (this.state.cleanupPromise) {
      return this.state.cleanupPromise;
    }
    this.state.contextState = "closing";
    this.state.cleanupPromise = Promise.resolve()
      .then(() => this.lifecycle.runCleanup())
      .finally(() => {
        this.state.contextState = "closed";
      });
    return this.state.cleanupPromise;
  }

  private stateError(operation: ContextOperation): ApplicationContextStateError {
    return new ApplicationContextStateError({ operation, state: this.state.contextState });
  }
}
