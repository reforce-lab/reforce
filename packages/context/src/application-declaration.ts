import { isObject } from "radashi";

// defineApplication 与 Injectable/Primary/Qualifier 同策略（ADR 0004 决策 5，#120）：编译器静态读取
// starters 数组字面量完成 starter 注册，运行时实现保持 no-op——编译后的应用不得依赖它的任何副作用。
// StarterDefinition 的品牌字段由 starter 包的类型声明携带（M2 起由 reforce lib 生成），运行时不校验。

const starterDefinitionBrand: unique symbol = Symbol("ReforceStarterDefinition");
const applicationDefinitionBrand: unique symbol = Symbol("ReforceApplicationDefinition");

export interface StarterDefinition {
  readonly [starterDefinitionBrand]: true;
}

export interface ApplicationDefinition {
  readonly [applicationDefinitionBrand]: true;
}

export interface DefineApplicationOptions {
  readonly starters: readonly StarterDefinition[];
}

class OwnedApplicationDefinition implements ApplicationDefinition {
  declare readonly [applicationDefinitionBrand]: true;
}

export function defineApplication(options: DefineApplicationOptions): ApplicationDefinition {
  if (!isObject(options)) {
    throw new TypeError("defineApplication options must be an object.");
  }
  if (!Array.isArray(options.starters)) {
    throw new TypeError("defineApplication requires a starters array.");
  }
  return Object.freeze(new OwnedApplicationDefinition());
}
