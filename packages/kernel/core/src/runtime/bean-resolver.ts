import { isPrimitive, isPromise } from "radashi";
import { BeanFactoryReturnError } from "@/argument-errors";
import {
  ApplicationContextStateError,
  BeanCreationError,
  EarlyBeanAccessError,
  InvalidGeneratedDefinitionError,
  ReforceError,
  RequestContextMissingError,
  UnregisteredBeanTargetError,
} from "@/errors";
import type {
  GeneratedBeanRegistration,
  GeneratedClassRegistration,
  GeneratedDependency,
  GeneratedResolver,
} from "@/generated/contracts";
import type { BeanClass, BeanDefinition, Current, Lazy } from "@/public-types";
import { createCycleProxy } from "@/runtime/cycle-proxy";
import { createLazyHandle } from "@/runtime/lazy-handle";
import type { RequestStore } from "@/runtime/request-scope";
import type { ResolutionState } from "@/runtime/resolution-state";

type ResolverMethod = "resolve" | "resolveAll" | "lazy" | "current";

export class BeanResolver {
  private readonly state: ResolutionState;

  constructor(state: ResolutionState) {
    this.state = state;
  }

  get<T extends object>(target: BeanClass<T> | BeanDefinition<T>): T {
    const id = this.state.beanId(target);
    if (!id) {
      throw new UnregisteredBeanTargetError(target);
    }
    if (this.state.registration(id)?.scope === "request") {
      return this.requestInstance(id) as T; // The identity map ties the registered target's generic type to this instance.
    }
    const record = this.state.record(id);
    if (record?.state !== "constructed") {
      throw new ApplicationContextStateError({ operation: "get", state: this.state.contextState });
    }
    return record.instance as T; // The identity map ties the registered target's generic type to this instance.
  }

  construct(id: string): object {
    const existing = this.state.record(id);
    if (existing?.state === "constructed") {
      return existing.instance;
    }
    if (existing?.state === "constructing") {
      throw new EarlyBeanAccessError({
        beanId: id,
        constructionPath: this.state.constructionPath(id),
      });
    }
    const registration = this.state.registration(id);
    if (!registration) {
      throw new InvalidGeneratedDefinitionError(`No registration exists for Bean ID "${id}".`);
    }
    // 计时点在记忆化早返回**之后**：早返回的那次不是一次构造，记进去会把同一条 bean 记两遍
    // （RFC 0011 C6，#250）。请求作用域的 constructRequest 刻意不记——那是每请求都要付的
    // 分配，而请求耗时已经由请求日志的 handlerMs 覆盖。
    const startedAt = this.state.timings.enter();
    this.state.beginConstruction(id);
    try {
      const instance =
        registration.kind === "class"
          ? registration.create(this.createGeneratedResolver(registration))
          : registration.create();
      if (isPrimitive(instance) || isPromise(instance)) {
        throw new BeanFactoryReturnError(["synchronously "]);
      }
      this.state.finishConstruction(id, instance);
      if (
        (registration.kind === "class" && registration.hooks.close) ||
        (registration.kind === "factory" && registration.dispose)
      ) {
        this.state.registerCleanup(id, registration, instance);
      }
      return instance;
    } catch (error) {
      this.state.abandonConstruction(id);
      if (error instanceof BeanCreationError || error instanceof InvalidGeneratedDefinitionError) {
        throw error;
      }
      throw new BeanCreationError({
        beanId: id,
        dependencyPath: this.state.constructionPath(),
        cause: error,
      });
    } finally {
      this.state.timings.exit(id, "construct", startedAt);
      this.state.finishConstructionAttempt();
    }
  }

  normalizeStartupError(error: unknown): ReforceError {
    if (error instanceof ReforceError) {
      return error;
    }
    return new BeanCreationError({
      beanId: this.state.currentConstructionId() ?? "<unknown>",
      dependencyPath: this.state.constructionPath(),
      cause: error,
    });
  }

  private createGeneratedResolver(
    registration: Pick<GeneratedClassRegistration, "id" | "dependencies">,
  ): GeneratedResolver {
    return Object.freeze({
      resolve: <T extends object>(dependencyIndex: number): T => {
        const dependency = this.readDependency(registration, dependencyIndex, "resolve");
        if (
          dependency.mode === "explicit-lazy" ||
          dependency.mode === "collection" ||
          dependency.mode === "current"
        ) {
          throw this.resolverModeError(registration.id, dependencyIndex, "resolve");
        }
        if (dependency.mode === "cycle-proxy") {
          return this.cycleProxy(dependency.targetId) as T; // Compiler-checked edge types are erased from generated data.
        }
        // request→request 的 eager 边在请求仓解析：目标由请求计划先行构造，缺席即计划被破坏。
        if (this.state.registration(dependency.targetId)?.scope === "request") {
          return this.requestInstance(dependency.targetId) as T; // Compiler-checked edge types are erased from generated data.
        }
        return this.construct(dependency.targetId) as T; // Compiler-checked edge types are erased from generated data.
      },
      resolveAll: <T extends object>(dependencyIndex: number): readonly T[] => {
        const dependency = this.readDependency(registration, dependencyIndex, "resolveAll");
        if (dependency.mode !== "collection") {
          throw this.resolverModeError(registration.id, dependencyIndex, "resolveAll");
        }
        const members = dependency.members.map((member) =>
          member.mode === "cycle-proxy"
            ? this.cycleProxy(member.targetId)
            : this.construct(member.targetId),
        );
        return Object.freeze(members) as readonly T[]; // Compiler-checked edge types are erased from generated data.
      },
      lazy: <T extends object>(dependencyIndex: number): Lazy<T> => {
        const dependency = this.readDependency(registration, dependencyIndex, "lazy");
        if (dependency.mode !== "explicit-lazy") {
          throw this.resolverModeError(registration.id, dependencyIndex, "lazy");
        }
        return this.lazy(dependency.targetId) as Lazy<T>; // Compiler-checked edge types are erased from generated data.
      },
      current: <T extends object>(dependencyIndex: number): Current<T> => {
        const dependency = this.readDependency(registration, dependencyIndex, "current");
        if (dependency.mode !== "current") {
          throw this.resolverModeError(registration.id, dependencyIndex, "current");
        }
        return this.currentHandle(registration.id, dependency.targetId) as Current<T>; // Compiler-checked edge types are erased from generated data.
      },
    });
  }

  // 请求计划执行（ADR 0006 W7）：runInRequestScope 按 requestConstructionOrder 逐个 await，
  // 构造时机全确定；create 允许 async（await 顺序被计划钉死）。请求仓内按 beanId 记忆化，
  // 播种者已有记录、直接跳过。
  async constructRequest(id: string, store: RequestStore): Promise<void> {
    if (store.record(id) !== undefined) {
      return;
    }
    const registration = this.state.registration(id);
    if (!registration) {
      throw new InvalidGeneratedDefinitionError(`No registration exists for Bean ID "${id}".`);
    }
    store.beginConstruction(id);
    try {
      const instance = await this.createRegistrationInstance(registration);
      if (isPrimitive(instance)) {
        throw new BeanFactoryReturnError([""]);
      }
      store.finishConstruction(id, instance);
    } catch (error) {
      store.abandonConstruction(id);
      if (error instanceof BeanCreationError || error instanceof InvalidGeneratedDefinitionError) {
        throw error;
      }
      throw new BeanCreationError({
        beanId: id,
        dependencyPath: store.constructionPath(),
        cause: error,
      });
    } finally {
      store.finishConstructionAttempt();
    }
  }

  private createRegistrationInstance(
    registration: GeneratedBeanRegistration,
  ): object | Promise<object> {
    return registration.kind === "class"
      ? registration.create(this.createGeneratedResolver(registration))
      : registration.create();
  }

  // Current 句柄：singleton 构造一次、终身持有；查找发生在 .get() 调用时刻，从当前请求仓取值。
  private currentHandle(consumerId: string, targetId: string): Current<object> {
    return Object.freeze({
      get: (): object => {
        const store = this.state.requestScope.active();
        if (store === undefined) {
          throw new RequestContextMissingError({
            targetBeanId: targetId,
            consumerBeanId: consumerId,
          });
        }
        return this.storedRequestInstance(store, targetId);
      },
    });
  }

  private requestInstance(targetId: string): object {
    const store = this.state.requestScope.active();
    if (store === undefined) {
      throw new RequestContextMissingError({ targetBeanId: targetId });
    }
    return this.storedRequestInstance(store, targetId);
  }

  private storedRequestInstance(store: RequestStore, targetId: string): object {
    const record = store.record(targetId);
    if (record?.state === "constructed") {
      return record.instance;
    }
    // 计划全量先行构造，这里只剩一种可达情形：请求计划执行途中，靠前的 bean 经 singleton
    // 方法链回读了计划里靠后的 bean。
    throw new EarlyBeanAccessError({
      beanId: targetId,
      constructionPath: store.constructionPath(targetId),
    });
  }

  private readDependency(
    registration: Pick<GeneratedClassRegistration, "id" | "dependencies">,
    dependencyIndex: number,
    method: ResolverMethod,
  ): GeneratedDependency {
    if (!Number.isInteger(dependencyIndex) || dependencyIndex < 0) {
      throw new InvalidGeneratedDefinitionError(
        `Resolver ${method} index for "${registration.id}" must be a non-negative integer.`,
      );
    }
    const dependency = registration.dependencies[dependencyIndex];
    if (!dependency || dependency.parameterIndex !== dependencyIndex) {
      throw new InvalidGeneratedDefinitionError(
        `Resolver ${method} index ${dependencyIndex} is not declared by "${registration.id}".`,
      );
    }
    return dependency;
  }

  private resolverModeError(
    beanId: string,
    dependencyIndex: number,
    method: ResolverMethod,
  ): InvalidGeneratedDefinitionError {
    return new InvalidGeneratedDefinitionError(
      `Resolver ${method} cannot consume dependency ${dependencyIndex} of "${beanId}".`,
    );
  }

  private cycleProxy(targetId: string): object {
    const existing = this.state.cycleProxy(targetId);
    if (existing) {
      return existing;
    }
    const proxy = createCycleProxy(() => this.resolveProxyTarget(targetId));
    this.state.rememberCycleProxy(targetId, proxy);
    return proxy;
  }

  private resolveProxyTarget(targetId: string): object {
    if (this.state.contextState === "closed") {
      throw new ApplicationContextStateError({
        operation: "cycle-proxy-access",
        state: this.state.contextState,
      });
    }
    const record = this.state.record(targetId);
    if (record?.state === "constructed") {
      return record.instance;
    }
    throw new EarlyBeanAccessError({
      beanId: targetId,
      constructionPath: this.state.constructionPath(targetId),
    });
  }

  private lazy(targetId: string): Lazy<object> {
    const existing = this.state.lazyHandle(targetId);
    if (existing) {
      return existing;
    }
    const handle = createLazyHandle(() => this.resolveLazyTarget(targetId));
    this.state.rememberLazyHandle(targetId, handle);
    return handle;
  }

  private resolveLazyTarget(targetId: string): object {
    const record = this.state.record(targetId);
    if (this.state.contextState === "starting") {
      if (record?.state === "constructed") {
        return record.instance;
      }
      if (record?.state === "constructing") {
        throw new EarlyBeanAccessError({
          beanId: targetId,
          constructionPath: this.state.constructionPath(targetId),
        });
      }
      return this.construct(targetId);
    }
    if (
      (this.state.contextState === "running" || this.state.contextState === "closing") &&
      record?.state === "constructed"
    ) {
      return record.instance;
    }
    throw new ApplicationContextStateError({
      operation: "lazy.get",
      state: this.state.contextState,
    });
  }
}
