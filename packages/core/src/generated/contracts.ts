import type { ConfigBindingIssue } from "@/errors";
import type { BeanClass, BeanDefinition, Current, Lazy } from "@/public-types";

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

// scope 是编译期属性（ADR 0006 W7，#142 / #151）：进生成物、进校验，运行时不做任何推断。
export type GeneratedBeanScope = "singleton" | "request";

// "current" 是 singleton→request 的唯一合法通道：注入的是稳定句柄，查找发生在 .get() 调用
// 时刻（ADR 0006 W7）。其余三种模式的组合合法性由 scope 两侧决定，见 validation。
export type GeneratedDependencyMode = "eager" | "cycle-proxy" | "explicit-lazy" | "current";

export interface GeneratedSingleDependency {
  readonly parameterIndex: number;
  readonly targetId: GeneratedBeanId;
  readonly mode: GeneratedDependencyMode;
  readonly source: GeneratedSourceReference;
}

// 集合成员没有 explicit-lazy：Lazy<T[]> 组合形态在编译期即被拒绝（ADR 0006 W6，#142）。
export type GeneratedCollectionMemberMode = "eager" | "cycle-proxy";

export interface GeneratedCollectionMember {
  readonly targetId: GeneratedBeanId;
  readonly mode: GeneratedCollectionMemberMode;
}

// 集合边（ADR 0006 W6，#142 / #150）：一个构造参数注入"图里所有提供该契约的 bean"。
// members 的数组顺序就是注入顺序——编译期按 @Order 与 beanId 决胜后写死，运行时不再排序。
export interface GeneratedCollectionDependency {
  readonly parameterIndex: number;
  readonly mode: "collection";
  readonly members: readonly GeneratedCollectionMember[];
  readonly source: GeneratedSourceReference;
}

export type GeneratedDependency = GeneratedSingleDependency | GeneratedCollectionDependency;

export interface GeneratedResolver {
  resolve<T extends object>(dependencyIndex: number): T;
  resolveAll<T extends object>(dependencyIndex: number): readonly T[];
  lazy<T extends object>(dependencyIndex: number): Lazy<T>;
  current<T extends object>(dependencyIndex: number): Current<T>;
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
  readonly scope: GeneratedBeanScope;
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
  readonly scope: GeneratedBeanScope;
  readonly definition: BeanDefinition<T>;
  readonly dependencies: readonly [];
  // 请求作用域工厂允许 async create（ADR 0006 W7）；singleton 工厂必须同步返回，由构造路径守卫。
  readonly create: () => T | Promise<T>;
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
  // 第二组计划（ADR 0006 W7）：请求 bean 的构造顺序，每请求照单执行，无按需构造。
  readonly requestConstructionOrder: readonly GeneratedBeanId[];
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

// The binding implementation lives outside this package (ADR 0005 keeps @reforce/core
// free of any schema vocabulary): the runtime only sees an opaque phase that either yields
// one instance per declared config or reports value-free issues.
export interface GeneratedConfigBinding {
  bind(configs: readonly GeneratedConfigRegistration[]): Promise<GeneratedConfigBindingOutcome>;
}

export interface GeneratedApplicationDefinition {
  readonly schemaVersion: 6;
  readonly configs: readonly GeneratedConfigRegistration[];
  readonly configBinding?: GeneratedConfigBinding;
  readonly registrations: readonly GeneratedBeanRegistration[];
  readonly plans: GeneratedExecutionPlans;
}
