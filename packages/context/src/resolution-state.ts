import type {
  GeneratedApplicationDefinition,
  GeneratedBeanRegistration,
} from "./generated-contracts";
import type { BeanClass, BeanDefinition, ContextState, Lazy } from "./public-types";

export interface ConstructingRecord {
  readonly state: "constructing";
}

export interface ConstructedRecord {
  readonly state: "constructed";
  readonly instance: object;
}

export type InstanceRecord = ConstructingRecord | ConstructedRecord;

export interface CleanupAction {
  readonly registration: GeneratedBeanRegistration;
  readonly instance: object;
  consumed: boolean;
}

export type ReadResolvedTarget = () => object;

export class ResolutionState {
  readonly definition: GeneratedApplicationDefinition;
  readonly #registrationById = new Map<string, GeneratedBeanRegistration>();
  readonly #targetIdentityToId = new Map<object, string>();
  readonly #definitionIdentityToId = new Map<object, string>();
  readonly #recordById = new Map<string, InstanceRecord>();
  readonly #constructionStack: string[] = [];
  readonly #cycleProxyByTargetId = new Map<string, object>();
  readonly #lazyHandleByTargetId = new Map<string, Lazy<object>>();
  readonly #cleanupLedger = new Map<string, CleanupAction>();
  #contextState: ContextState = "created";
  #startPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #cleanupPromise: Promise<void> | undefined;
  #closeRequested = false;

  constructor(definition: GeneratedApplicationDefinition) {
    this.definition = definition;
    for (const registration of definition.registrations) {
      this.#registrationById.set(registration.id, registration);
      if (registration.kind === "class") {
        this.#targetIdentityToId.set(registration.target, registration.id);
      } else {
        this.#definitionIdentityToId.set(registration.definition, registration.id);
      }
    }
  }

  get contextState(): ContextState {
    return this.#contextState;
  }

  set contextState(state: ContextState) {
    this.#contextState = state;
  }

  get startPromise(): Promise<void> | undefined {
    return this.#startPromise;
  }

  set startPromise(promise: Promise<void> | undefined) {
    this.#startPromise = promise;
  }

  get closePromise(): Promise<void> | undefined {
    return this.#closePromise;
  }

  set closePromise(promise: Promise<void> | undefined) {
    this.#closePromise = promise;
  }

  get cleanupPromise(): Promise<void> | undefined {
    return this.#cleanupPromise;
  }

  set cleanupPromise(promise: Promise<void> | undefined) {
    this.#cleanupPromise = promise;
  }

  get closeRequested(): boolean {
    return this.#closeRequested;
  }

  requestClose(): void {
    this.#closeRequested = true;
  }

  registration(id: string): GeneratedBeanRegistration | undefined {
    return this.#registrationById.get(id);
  }

  beanId(target: BeanClass | BeanDefinition<object>): string | undefined {
    return this.#targetIdentityToId.get(target) ?? this.#definitionIdentityToId.get(target);
  }

  record(id: string): InstanceRecord | undefined {
    return this.#recordById.get(id);
  }

  beginConstruction(id: string): void {
    this.#recordById.set(id, { state: "constructing" });
    this.#constructionStack.push(id);
  }

  finishConstruction(id: string, instance: object): void {
    this.#recordById.set(id, { state: "constructed", instance });
  }

  abandonConstruction(id: string): void {
    this.#recordById.delete(id);
  }

  finishConstructionAttempt(): void {
    this.#constructionStack.pop();
  }

  constructionPath(targetId?: string): readonly string[] {
    return targetId ? [...this.#constructionStack, targetId] : [...this.#constructionStack];
  }

  currentConstructionId(): string | undefined {
    return this.#constructionStack.at(-1);
  }

  cycleProxy(targetId: string): object | undefined {
    return this.#cycleProxyByTargetId.get(targetId);
  }

  rememberCycleProxy(targetId: string, proxy: object): void {
    this.#cycleProxyByTargetId.set(targetId, proxy);
  }

  lazyHandle(targetId: string): Lazy<object> | undefined {
    return this.#lazyHandleByTargetId.get(targetId);
  }

  rememberLazyHandle(targetId: string, handle: Lazy<object>): void {
    this.#lazyHandleByTargetId.set(targetId, handle);
  }

  registerCleanup(id: string, registration: GeneratedBeanRegistration, instance: object): void {
    this.#cleanupLedger.set(id, { registration, instance, consumed: false });
  }

  consumeCleanup(id: string): CleanupAction | undefined {
    const action = this.#cleanupLedger.get(id);
    if (!action || action.consumed) {
      return undefined;
    }
    action.consumed = true;
    return action;
  }
}
