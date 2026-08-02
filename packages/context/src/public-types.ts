const beanDefinitionBrand: unique symbol = Symbol("ReforceBeanDefinition");
const qualifiedBeanBrand: unique symbol = Symbol("ReforceQualifiedBean");

export type BeanClass<T extends object = object> = abstract new (...args: never[]) => T;

export interface BeanDefinition<T extends object> {
  readonly [beanDefinitionBrand]: T;
}

export type QualifiedBean<T extends object, BeanId extends string> = T & {
  readonly [qualifiedBeanBrand]?: BeanId;
};

export interface Lazy<T extends object> {
  get(): T;
}

export interface OnContextStart {
  onContextStart(): void | Promise<void>;
}

export interface OnContextClose {
  onContextClose(): void | Promise<void>;
}

export interface ApplicationContext {
  start(): Promise<void>;
  get<T extends object>(target: BeanClass<T> | BeanDefinition<T>): T;
  close(): Promise<void>;
}

export type ContextState = "created" | "starting" | "running" | "failed" | "closing" | "closed";

export type ContextOperation = "start" | "get" | "lazy.get" | "cycle-proxy-access";

export { beanDefinitionBrand };
