import type {
  GeneratedApplicationDefinition,
  GeneratedBeanRegistration,
} from "@/generated-contracts";
import type { BeanClass, BeanDefinition, ContextState, Lazy } from "@/public-types";

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
  private readonly registrationById = new Map<string, GeneratedBeanRegistration>();
  private readonly targetIdentityToId = new Map<object, string>();
  private readonly definitionIdentityToId = new Map<object, string>();
  private readonly recordById = new Map<string, InstanceRecord>();
  private readonly constructionStack: string[] = [];
  private readonly cycleProxyByTargetId = new Map<string, object>();
  private readonly lazyHandleByTargetId = new Map<string, Lazy<object>>();
  private readonly cleanupLedger = new Map<string, CleanupAction>();
  private contextStateValue: ContextState = "created";
  private startPromiseValue: Promise<void> | undefined;
  private closePromiseValue: Promise<void> | undefined;
  private cleanupPromiseValue: Promise<void> | undefined;
  private closeRequestedValue = false;

  constructor(definition: GeneratedApplicationDefinition) {
    this.definition = definition;
    for (const registration of definition.registrations) {
      this.registrationById.set(registration.id, registration);
      if (registration.kind === "class") {
        this.targetIdentityToId.set(registration.target, registration.id);
      } else {
        this.definitionIdentityToId.set(registration.definition, registration.id);
      }
    }
  }

  get contextState(): ContextState {
    return this.contextStateValue;
  }

  set contextState(state: ContextState) {
    this.contextStateValue = state;
  }

  get startPromise(): Promise<void> | undefined {
    return this.startPromiseValue;
  }

  set startPromise(promise: Promise<void> | undefined) {
    this.startPromiseValue = promise;
  }

  get closePromise(): Promise<void> | undefined {
    return this.closePromiseValue;
  }

  set closePromise(promise: Promise<void> | undefined) {
    this.closePromiseValue = promise;
  }

  get cleanupPromise(): Promise<void> | undefined {
    return this.cleanupPromiseValue;
  }

  set cleanupPromise(promise: Promise<void> | undefined) {
    this.cleanupPromiseValue = promise;
  }

  get closeRequested(): boolean {
    return this.closeRequestedValue;
  }

  requestClose(): void {
    this.closeRequestedValue = true;
  }

  registration(id: string): GeneratedBeanRegistration | undefined {
    return this.registrationById.get(id);
  }

  beanId(target: BeanClass | BeanDefinition<object>): string | undefined {
    return this.targetIdentityToId.get(target) ?? this.definitionIdentityToId.get(target);
  }

  record(id: string): InstanceRecord | undefined {
    return this.recordById.get(id);
  }

  beginConstruction(id: string): void {
    this.recordById.set(id, { state: "constructing" });
    this.constructionStack.push(id);
  }

  finishConstruction(id: string, instance: object): void {
    this.recordById.set(id, { state: "constructed", instance });
  }

  abandonConstruction(id: string): void {
    this.recordById.delete(id);
  }

  finishConstructionAttempt(): void {
    this.constructionStack.pop();
  }

  constructionPath(targetId?: string): readonly string[] {
    return targetId ? [...this.constructionStack, targetId] : [...this.constructionStack];
  }

  currentConstructionId(): string | undefined {
    return this.constructionStack.at(-1);
  }

  cycleProxy(targetId: string): object | undefined {
    return this.cycleProxyByTargetId.get(targetId);
  }

  rememberCycleProxy(targetId: string, proxy: object): void {
    this.cycleProxyByTargetId.set(targetId, proxy);
  }

  lazyHandle(targetId: string): Lazy<object> | undefined {
    return this.lazyHandleByTargetId.get(targetId);
  }

  rememberLazyHandle(targetId: string, handle: Lazy<object>): void {
    this.lazyHandleByTargetId.set(targetId, handle);
  }

  registerCleanup(id: string, registration: GeneratedBeanRegistration, instance: object): void {
    this.cleanupLedger.set(id, { registration, instance, consumed: false });
  }

  consumeCleanup(id: string): CleanupAction | undefined {
    const action = this.cleanupLedger.get(id);
    if (!action || action.consumed) {
      return undefined;
    }
    action.consumed = true;
    return action;
  }
}
