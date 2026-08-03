import { isPrimitive, isPromise } from "radashi";
import {
  ApplicationContextStateError,
  BeanCreationError,
  EarlyBeanAccessError,
  InvalidGeneratedDefinitionError,
  ReforceRuntimeError,
  UnregisteredBeanTargetError,
} from "@/errors";
import type {
  GeneratedClassRegistration,
  GeneratedDependency,
  GeneratedResolver,
} from "@/generated/contracts";
import type { BeanClass, BeanDefinition, Lazy } from "@/public-types";
import { createCycleProxy } from "@/runtime/cycle-proxy";
import { createLazyHandle } from "@/runtime/lazy-handle";
import type { ResolutionState } from "@/runtime/resolution-state";

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
    this.state.beginConstruction(id);
    try {
      const instance =
        registration.kind === "class"
          ? registration.create(this.createGeneratedResolver(registration))
          : registration.create();
      if (isPrimitive(instance) || isPromise(instance)) {
        throw new TypeError("Bean creation must synchronously return an object.");
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
      this.state.finishConstructionAttempt();
    }
  }

  normalizeStartupError(error: unknown): ReforceRuntimeError {
    if (error instanceof ReforceRuntimeError) {
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
        if (dependency.mode === "explicit-lazy") {
          throw this.resolverModeError(registration.id, dependencyIndex, "resolve");
        }
        if (dependency.mode === "cycle-proxy") {
          return this.cycleProxy(dependency.targetId) as T; // Compiler-checked edge types are erased from generated data.
        }
        return this.construct(dependency.targetId) as T; // Compiler-checked edge types are erased from generated data.
      },
      lazy: <T extends object>(dependencyIndex: number): Lazy<T> => {
        const dependency = this.readDependency(registration, dependencyIndex, "lazy");
        if (dependency.mode !== "explicit-lazy") {
          throw this.resolverModeError(registration.id, dependencyIndex, "lazy");
        }
        return this.lazy(dependency.targetId) as Lazy<T>; // Compiler-checked edge types are erased from generated data.
      },
    });
  }

  private readDependency(
    registration: Pick<GeneratedClassRegistration, "id" | "dependencies">,
    dependencyIndex: number,
    method: "resolve" | "lazy",
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
    method: "resolve" | "lazy",
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
