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

export type BeanTimingPhase = "construct" | "start";

// 启动台账的一条（RFC 0011 C6，#250）。单例构造由构造路径强制同步返回，构造函数 await 不了
// 任何 I/O——连接池握手、schema 预热全在 @OnContextStart 里，所以两个 phase 都要记，只记
// construct 等于把「谁慢」问出一份全是 0.0ms 的名单。
export interface BeanTiming {
  readonly id: string;
  readonly phase: BeanTimingPhase;
  /** 自身耗时，毫秒，3 位小数（已减去嵌套构造的子耗时）。 */
  readonly ms: number;
}

// start() 的返回值而不是新加一个方法：数据恰好在 start 完成那一刻才完整，返回值天然带这个
// 时序约束，不需要再写一道状态守卫。容器不认识任何 @reforce 包（package.json 里零 @reforce
// 依赖），所以它交出数据、由生成的 bootstrap 决定要不要打日志。
export interface ContextStartReport {
  readonly beanTimings: readonly BeanTiming[];
}

/**
 * 一次请求随身携带的事实（#380），跟着请求作用域同一条 await 链传播，`currentRequestFacts()`
 * 读回。容器不解释里面的键——它们属于开作用域的那一层（web 放的是 method/path/requestId）。
 */
export type RequestFacts = Readonly<Record<string, unknown>>;

export interface ApplicationContext {
  start(): Promise<ContextStartReport>;
  get<T extends object>(target: BeanClass<T> | BeanDefinition<T>): T;
  /**
   * 这个应用声明过请求作用域 bean 吗（#380）。编译期定死的事实，启动后恒定。
   *
   * 它是给引擎接线用的：一个请求 bean 都没有的应用，每请求那次 `runInRequestScope` 开出来
   * 的是一个永远没人查的空仓，而 `AsyncLocalStorage.run()` 实测约 175ns。
   */
  readonly hasRequestScopedBeans: boolean;
  // 开启请求作用域并播种根请求值（ADR 0006 W7）：按 requestConstructionOrder 全量构造请求
  // bean（播种者跳过构造），然后在该请求上下文里执行 callback。#153 的引擎适配器是它的
  // 目标调用方。facts 缺省不带（#380）。
  runInRequestScope<R>(
    seeds: readonly RequestScopeSeed[],
    callback: () => R,
    facts?: RequestFacts,
  ): Promise<Awaited<R>>;
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
