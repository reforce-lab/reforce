import type { BeanClass, BeanDefinition, Lazy } from "#internal/public-types";

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

export interface GeneratedClassRegistration<T extends object = object> {
  readonly kind: "class";
  readonly id: GeneratedBeanId;
  readonly source: GeneratedSourceReference;
  readonly target: BeanClass<T>;
  readonly dependencies: readonly GeneratedDependency[];
  readonly create: (resolver: GeneratedResolver) => T;
  readonly hooks: GeneratedClassHooks<T>;
}

export interface GeneratedFactoryRegistration<T extends object = object> {
  readonly kind: "factory";
  readonly id: GeneratedBeanId;
  readonly source: GeneratedSourceReference;
  readonly definition: BeanDefinition<T>;
  readonly dependencies: readonly [];
  readonly create: () => T;
  readonly dispose?: (instance: T) => void | Promise<void>;
}

export interface GeneratedFactoryBeanInput<T extends object> {
  readonly id: GeneratedBeanId;
  readonly source: GeneratedSourceReference;
  readonly definition: BeanDefinition<T>;
}

export type GeneratedBeanRegistration =
  | (Omit<GeneratedClassRegistration<object>, "hooks"> & {
      readonly hooks: GeneratedClassHooks<never>;
    })
  | (Omit<GeneratedFactoryRegistration<object>, "dispose"> & {
      readonly dispose?: (instance: never) => void | Promise<void>;
    });

export interface GeneratedExecutionPlans {
  readonly constructionOrder: readonly GeneratedBeanId[];
  readonly startActionOrder: readonly GeneratedBeanId[];
  readonly cleanupActionOrder: readonly GeneratedBeanId[];
}

export interface GeneratedApplicationDefinition {
  readonly schemaVersion: 1;
  readonly registrations: readonly GeneratedBeanRegistration[];
  readonly plans: GeneratedExecutionPlans;
}
