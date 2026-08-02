import { isObject } from "radashi";
import { InvalidGeneratedDefinitionError } from "./errors";
import { type BeanClass, type BeanDefinition, beanDefinitionBrand } from "./public-types";

export interface DefineBeanOptions<T extends object> {
  readonly create: () => T;
  readonly dispose?: (instance: T) => void | Promise<void>;
  readonly primary?: boolean;
  readonly qualifier?: string;
}

class OwnedBeanDefinition<T extends object> implements BeanDefinition<T> {
  declare readonly [beanDefinitionBrand]: T;
  readonly #options: DefineBeanOptions<T>;

  constructor(options: DefineBeanOptions<T>) {
    this.#options = Object.freeze({ ...options });
  }

  static read<T extends object>(definition: OwnedBeanDefinition<T>): DefineBeanOptions<T> {
    return definition.#options;
  }
}

function isOwnedBeanDefinition<T extends object>(
  definition: BeanDefinition<T>,
): definition is OwnedBeanDefinition<T> {
  return definition instanceof OwnedBeanDefinition;
}

export function defineBean<T extends object>(options: DefineBeanOptions<T>): BeanDefinition<T> {
  if (!isObject(options)) {
    throw new TypeError("defineBean options must be an object.");
  }
  if (typeof options.create !== "function") {
    throw new TypeError("defineBean requires a create function.");
  }
  if (options.dispose !== undefined && typeof options.dispose !== "function") {
    throw new TypeError("defineBean dispose must be a function when provided.");
  }
  if (options.primary !== undefined && typeof options.primary !== "boolean") {
    throw new TypeError("defineBean primary must be a boolean when provided.");
  }
  if (options.qualifier !== undefined && typeof options.qualifier !== "string") {
    throw new TypeError("defineBean qualifier must be a string when provided.");
  }

  return Object.freeze(new OwnedBeanDefinition(options));
}

export function readBeanDefinitionOptions<T extends object>(
  definition: BeanDefinition<T>,
): DefineBeanOptions<T> {
  if (!isOwnedBeanDefinition(definition)) {
    throw new InvalidGeneratedDefinitionError(
      "Factory registration must reference a definition created by defineBean().",
    );
  }
  return OwnedBeanDefinition.read(definition);
}

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

export function Qualifier(
  name: string,
): <T extends BeanClass>(value: T, context: ClassDecoratorContext<T>) => void {
  if (typeof name !== "string") {
    throw new TypeError("Qualifier name must be a string.");
  }
  return () => undefined;
}
