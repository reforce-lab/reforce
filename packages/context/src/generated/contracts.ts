import type { ConfigBindingIssue } from "@/errors";
import type { BeanClass, BeanDefinition, Lazy } from "@/public-types";

export type GeneratedBeanId = string;

export interface GeneratedSourcePosition {
  readonly offset: number;
  readonly line: number;
  readonly character: number;
}

export interface GeneratedSourceReference {
  readonly file: string;
  readonly start: GeneratedSourcePosition;
  readonly end: GeneratedSourcePosition;
}

export type GeneratedDependencyMode = "eager" | "cycle-proxy" | "explicit-lazy";

export interface GeneratedDependency {
  readonly parameterIndex: number;
  readonly targetId: GeneratedBeanId;
  readonly mode: GeneratedDependencyMode;
  readonly source: GeneratedSourceReference;
}

export interface GeneratedResolver {
  resolve<T extends object>(dependencyIndex: number): T;
  lazy<T extends object>(dependencyIndex: number): Lazy<T>;
}

export interface GeneratedClassHooks<T extends object> {
  readonly start?: (instance: T) => void | Promise<void>;
  readonly close?: (instance: T) => void | Promise<void>;
}

// The callback input type is a separate parameter from the instance type so that the
// erased union below can pin it to `never` without needing a second, hand-mirrored copy
// of every registration helper. It defaults to `T`, which is what every declaring
// caller (classBean, factoryBean, the emitted applications) wants (Issue #106).
export interface GeneratedClassRegistration<T extends object = object, THook extends object = T> {
  readonly kind: "class";
  readonly id: GeneratedBeanId;
  readonly source: GeneratedSourceReference;
  readonly target: BeanClass<T>;
  readonly dependencies: readonly GeneratedDependency[];
  readonly create: (resolver: GeneratedResolver) => T;
  readonly hooks: GeneratedClassHooks<THook>;
}

export interface GeneratedFactoryRegistration<
  T extends object = object,
  TDispose extends object = T,
> {
  readonly kind: "factory";
  readonly id: GeneratedBeanId;
  readonly source: GeneratedSourceReference;
  readonly definition: BeanDefinition<T>;
  readonly dependencies: readonly [];
  readonly create: () => T;
  readonly dispose?: (instance: TDispose) => void | Promise<void>;
}

export interface GeneratedFactoryBeanInput<T extends object> {
  readonly id: GeneratedBeanId;
  readonly source: GeneratedSourceReference;
  readonly definition: BeanDefinition<T>;
}

// A registration held by the runtime says nothing about which instance type it produces,
// so its callbacks accept `never`: only the code that declared the registration knows
// what may be passed to them.
export type GeneratedBeanRegistration =
  | GeneratedClassRegistration<object, never>
  | GeneratedFactoryRegistration<object, never>;

export interface GeneratedExecutionPlans {
  readonly constructionOrder: readonly GeneratedBeanId[];
  readonly startActionOrder: readonly GeneratedBeanId[];
  readonly cleanupActionOrder: readonly GeneratedBeanId[];
}

export interface GeneratedConfigRegistration<T extends object = object> {
  readonly kind: "config";
  readonly id: GeneratedBeanId;
  readonly source: GeneratedSourceReference;
  readonly target: BeanClass<T>;
}

export type GeneratedConfigBindingOutcome =
  | {
      readonly status: "bound";
      readonly instances: ReadonlyMap<GeneratedBeanId, object>;
    }
  | {
      readonly status: "failed";
      readonly issues: readonly ConfigBindingIssue[];
    };

// The binding implementation lives outside this package (ADR 0005 keeps @reforce/context
// free of any schema vocabulary): the runtime only sees an opaque phase that either yields
// one instance per declared config or reports value-free issues.
export interface GeneratedConfigBinding {
  bind(configs: readonly GeneratedConfigRegistration[]): Promise<GeneratedConfigBindingOutcome>;
}

export interface GeneratedApplicationDefinition {
  readonly schemaVersion: 2;
  readonly configs: readonly GeneratedConfigRegistration[];
  readonly configBinding?: GeneratedConfigBinding;
  readonly registrations: readonly GeneratedBeanRegistration[];
  readonly plans: GeneratedExecutionPlans;
}
