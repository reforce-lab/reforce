import { isObject } from "radashi";
import {
  describeValue,
  InvalidBeanDisposeError,
  InvalidBeanOptionsError,
  InvalidBeanPrimaryError,
  InvalidBeanQualifierError,
  InvalidBeanScopeError,
  InvalidOrderValueError,
  InvalidQualifierNameError,
  MissingBeanFactoryError,
  RequestBeanDisposeError,
} from "@/argument-errors";
import { InvalidGeneratedDefinitionError } from "@/errors";
import { type BeanClass, type BeanDefinition, beanDefinitionBrand } from "@/public-types";

export interface DefineBeanOptions<T extends object> {
  readonly create: () => T;
  readonly dispose?: (instance: T) => void | Promise<void>;
  readonly primary?: boolean;
  readonly qualifier?: string;
}

// 请求作用域工厂（ADR 0006 W7，#151）：create 允许 async（请求计划本就在异步链里按序 await）；
// 请求实例随请求结束，没有 context 级 cleanup 相位可挂，因此没有 dispose。
export interface DefineRequestBeanOptions<T extends object> {
  readonly scope: "request";
  readonly create: () => T | Promise<T>;
  readonly primary?: boolean;
  readonly qualifier?: string;
}

export type BeanDefinitionOptions<T extends object> =
  | DefineBeanOptions<T>
  | DefineRequestBeanOptions<T>;

class OwnedBeanDefinition<T extends object> implements BeanDefinition<T> {
  declare readonly [beanDefinitionBrand]: T;
  private readonly options: BeanDefinitionOptions<T>;

  constructor(options: BeanDefinitionOptions<T>) {
    this.options = Object.freeze({ ...options });
  }

  static read<T extends object>(definition: OwnedBeanDefinition<T>): BeanDefinitionOptions<T> {
    return definition.options;
  }
}

function isOwnedBeanDefinition<T extends object>(
  definition: BeanDefinition<T>,
): definition is OwnedBeanDefinition<T> {
  return definition instanceof OwnedBeanDefinition;
}

export function defineBean<T extends object>(options: BeanDefinitionOptions<T>): BeanDefinition<T> {
  if (!isObject(options)) {
    throw new InvalidBeanOptionsError([describeValue(options)]);
  }
  if (typeof options.create !== "function") {
    throw new MissingBeanFactoryError([]);
  }
  // 与其余守卫同理服务未经编译的调用方：scope 词汇表封闭为 "request"，dispose 只属于 singleton。
  const scope = Reflect.get(options, "scope");
  if (scope !== undefined && scope !== "request") {
    throw new InvalidBeanScopeError([describeValue(scope)]);
  }
  const dispose = Reflect.get(options, "dispose");
  if (scope === "request" && dispose !== undefined) {
    throw new RequestBeanDisposeError([]);
  }
  if (dispose !== undefined && typeof dispose !== "function") {
    throw new InvalidBeanDisposeError([describeValue(dispose)]);
  }
  if (options.primary !== undefined && typeof options.primary !== "boolean") {
    throw new InvalidBeanPrimaryError([describeValue(options.primary)]);
  }
  if (options.qualifier !== undefined && typeof options.qualifier !== "string") {
    throw new InvalidBeanQualifierError([describeValue(options.qualifier)]);
  }

  return Object.freeze(new OwnedBeanDefinition(options));
}

export function readBeanDefinitionOptions<T extends object>(
  definition: BeanDefinition<T>,
): BeanDefinitionOptions<T> {
  if (!isOwnedBeanDefinition(definition)) {
    throw new InvalidGeneratedDefinitionError(
      "Factory registration must reference a definition created by defineBean().",
    );
  }
  return OwnedBeanDefinition.read(definition);
}

export function beanDefinitionScope<T extends object>(
  options: BeanDefinitionOptions<T>,
): "singleton" | "request" {
  return "scope" in options && options.scope === "request" ? "request" : "singleton";
}

// Injectable/Primary/Qualifier are compile-time markers: the compiler reads them
// statically and emits the registrations, so their runtime implementations must stay
// no-ops — a compiled application must not depend on decorator side effects.
// Qualifier still validates its name at runtime because uncompiled callers (plain
// JS, or ts without the Reforce compiler) get no compile-time diagnostic and would
// otherwise only fail much later with a confusing resolution error.
export function Injectable(): <T extends BeanClass>(
  value: T,
  context: ClassDecoratorContext<T>,
) => void {
  return () => undefined;
}

export function Primary(): <T extends BeanClass>(
  value: T,
  context: ClassDecoratorContext<T>,
) => void {
  return () => undefined;
}

// scope 是编译期属性（ADR 0006 W7，#151）：编译器读取标记并把 scope 写进生成物，运行时按
// 生成物执行，装饰器本身照惯例保持 no-op。
export function RequestScoped(): <T extends BeanClass>(
  value: T,
  context: ClassDecoratorContext<T>,
) => void {
  return () => undefined;
}

export function Qualifier(
  name: string,
): <T extends BeanClass>(value: T, context: ClassDecoratorContext<T>) => void {
  if (typeof name !== "string") {
    throw new InvalidQualifierNameError([describeValue(name)]);
  }
  return () => undefined;
}

// Order 只服务集合注入的成员排序（ADR 0006 W6，#142 / #150）：数值升序，同序值与无 @Order 的
// 成员按 beanId 决胜。与 Qualifier 同理保留运行时守卫，让未经编译的调用方立刻失败。
export function Order(
  order: number,
): <T extends BeanClass>(value: T, context: ClassDecoratorContext<T>) => void {
  if (typeof order !== "number" || !Number.isInteger(order)) {
    throw new InvalidOrderValueError([describeValue(order)]);
  }
  return () => undefined;
}
