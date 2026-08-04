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

// Current<T> 与 Lazy<T> 同族（ADR 0006 W7，#151）：singleton 持有的稳定句柄，.get() 在调用
// 时刻从当前请求仓取值——查找时机在调用点，不在注入点，作用域因此不传染。
export interface Current<T extends object> {
  get(): T;
}

export interface RequestScopeSeed<T extends object = object> {
  readonly target: BeanClass<T> | BeanDefinition<T>;
  readonly instance: T;
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
  // 开启请求作用域并播种根请求值（ADR 0006 W7）：按 requestConstructionOrder 全量构造请求
  // bean（播种者跳过构造），然后在该请求上下文里执行 callback。#153 的引擎适配器是它的
  // 目标调用方。
  runInRequestScope<R>(seeds: readonly RequestScopeSeed[], callback: () => R): Promise<Awaited<R>>;
  close(): Promise<void>;
}

export type ContextState = "created" | "starting" | "running" | "failed" | "closing" | "closed";

export type ContextOperation =
  | "start"
  | "get"
  | "lazy.get"
  | "cycle-proxy-access"
  | "runInRequestScope";

export { beanDefinitionBrand };
