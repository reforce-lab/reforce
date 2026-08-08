import { isObject } from "radashi";
import {
  DuplicateRequestSeedError,
  describeValue,
  InvalidRequestSeedError,
  InvalidRequestSeedsError,
  SeedInstanceTypeMismatchError,
  SeedTargetNotRequestScopedError,
} from "@/argument-errors";
import {
  ApplicationCleanupError,
  ApplicationContextStateError,
  ApplicationStartError,
  type CleanupActionError,
  ConfigBindingError,
  InvalidGeneratedDefinitionError,
  UnregisteredBeanTargetError,
} from "@/errors";
import type { GeneratedApplicationDefinition } from "@/generated/contracts";
import { validateConfigBindingOutcome } from "@/generated/validation";
import type {
  ApplicationContext,
  BeanClass,
  BeanDefinition,
  ContextOperation,
  ContextStartReport,
  RequestScopeSeed,
} from "@/public-types";
import { BeanResolver } from "@/runtime/bean-resolver";
import { LifecycleRunner } from "@/runtime/lifecycle-runner";
import { RequestStore } from "@/runtime/request-scope";
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

  start(): Promise<ContextStartReport> {
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

  // 开启请求作用域并播种根请求值（ADR 0006 W7，#151）：请求仓挂上 ALS 后按
  // requestConstructionOrder 全量构造（播种者跳过），callback 与其 await 链内的任何
  // Current.get 都取到这一仓。嵌套调用即独立请求，内层结束后外层自动恢复。
  async runInRequestScope<R>(
    seeds: readonly RequestScopeSeed[],
    callback: () => R,
  ): Promise<Awaited<R>> {
    if (this.state.contextState !== "running") {
      throw this.stateError("runInRequestScope");
    }
    const store = new RequestStore();
    for (const [id, instance] of this.collectSeeds(seeds)) {
      store.seed(id, instance);
    }
    return await this.state.requestScope.run(store, async () => {
      for (const id of this.state.definition.plans.requestConstructionOrder) {
        await this.resolver.constructRequest(id, store);
      }
      return await callback();
    });
  }

  // 播种是调用方输入而非生成物，坏输入按 defineBean 先例抛 TypeError（未注册目标沿用
  // UnregisteredBeanTargetError）。
  private collectSeeds(seeds: readonly RequestScopeSeed[]): ReadonlyMap<string, object> {
    if (!Array.isArray(seeds)) {
      throw new InvalidRequestSeedsError([describeValue(seeds)]);
    }
    const byId = new Map<string, object>();
    for (const seed of seeds) {
      // 公开签名类型化，运行时仍按不可信输入逐字段复检（与 generated/validation 同一惯例）。
      const instance = isObject(seed) ? Reflect.get(seed, "instance") : undefined;
      if (!isObject(instance)) {
        throw new InvalidRequestSeedError([]);
      }
      const target = Reflect.get(seed, "target");
      const id = this.state.beanId(target);
      if (!id) {
        throw new UnregisteredBeanTargetError(target);
      }
      const registration = this.state.registration(id);
      if (registration?.scope !== "request") {
        throw new SeedTargetNotRequestScopedError([id]);
      }
      if (registration.kind === "class" && !(instance instanceof registration.target)) {
        throw new SeedInstanceTypeMismatchError([id]);
      }
      if (byId.has(id)) {
        throw new DuplicateRequestSeedError([id]);
      }
      byId.set(id, instance);
    }
    return byId;
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

  private async runStart(): Promise<ContextStartReport> {
    try {
      await this.bindConfigs();
      for (const id of this.state.definition.plans.constructionOrder) {
        this.resolver.construct(id);
      }
      await this.lifecycle.runStartActions();
      if (this.state.closeRequested) {
        this.state.contextState = "closing";
        this.beginCleanup();
        // 提前收场这条也得给报告：调用方拿到的是同一个 promise，两条路的返回类型必须一致，
        // 否则 undefined 会漏进启动摘要。
        return { beanTimings: this.state.timings.snapshot() };
      }
      this.state.contextState = "running";
      return { beanTimings: this.state.timings.snapshot() };
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
    // 信任边界（#314）：binding 实现在 core 之外，返回值按不可信输入验形后才允许分派。
    const outcome: unknown = await configBinding.bind(configs);
    validateConfigBindingOutcome(outcome);
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
