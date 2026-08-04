import {
  ApplicationCleanupError,
  ApplicationContextStateError,
  ApplicationStartError,
  type CleanupActionError,
  ConfigBindingError,
  InvalidGeneratedDefinitionError,
} from "@/errors";
import type {
  GeneratedApplicationDefinition,
  GeneratedConfigBindingOutcome,
} from "@/generated/contracts";
import type {
  ApplicationContext,
  BeanClass,
  BeanDefinition,
  ContextOperation,
} from "@/public-types";
import { BeanResolver } from "@/runtime/bean-resolver";
import { LifecycleRunner } from "@/runtime/lifecycle-runner";
import { ResolutionState } from "@/runtime/resolution-state";

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
      await this.bindConfigs();
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

  // 独立于 bean 构造的绑定 phase（ADR 0005 决策 6.1）：全部 config 一次 bind，失败即聚合
  // 退出，不逐个 fail-fast；成功实例按 exactly-once 纪律预 seed 为已构造记录。
  private async bindConfigs(): Promise<void> {
    const { configs, configBinding } = this.state.definition;
    if (configs.length === 0 || configBinding === undefined) {
      return;
    }
    const outcome = await configBinding.bind(configs);
    this.requireOutcomeShape(outcome);
    if (outcome.status === "failed") {
      throw new ConfigBindingError({ issues: outcome.issues });
    }
    for (const config of configs) {
      const instance = outcome.instances.get(config.id);
      if (!(instance instanceof config.target)) {
        throw new InvalidGeneratedDefinitionError(
          `config binding did not produce an instance of "${config.id}".`,
        );
      }
      this.state.seedConstructed(config.id, instance);
    }
  }

  private requireOutcomeShape(
    outcome: GeneratedConfigBindingOutcome,
  ): asserts outcome is GeneratedConfigBindingOutcome {
    if (outcome === null || typeof outcome !== "object") {
      throw new InvalidGeneratedDefinitionError(
        "configBinding.bind must resolve to an outcome object.",
      );
    }
    if (outcome.status === "failed" && Array.isArray(outcome.issues)) {
      return;
    }
    if (outcome.status === "bound" && typeof outcome.instances?.get === "function") {
      return;
    }
    throw new InvalidGeneratedDefinitionError(
      "configBinding.bind resolved to an unrecognized outcome shape.",
    );
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
