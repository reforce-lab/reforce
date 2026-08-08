import { isObject } from "radashi";
import {
  describeValue,
  InvalidApplicationOptionsError,
  MissingApplicationStartersError,
} from "@/argument-errors";

// defineApplication 与 Injectable/Primary/Qualifier 同策略（ADR 0004 决策 5，#120）：编译器静态读取
// starters 数组字面量完成 starter 注册，运行时实现保持 no-op——编译后的应用不得依赖它的任何副作用。
// defineStarter 是 starter 包作者手写在主入口的注册 handle（ADR 0004，#120）：品牌 symbol 不出本
// 模块，包作者写不出这个类型，仓库又禁止 `as` 断言，所以只能由本文件出一个工厂。编译器不执行也不
// 读它——注册靠 defineApplication 的数组字面量加 reforce-meta.json——它在运行时同样是常量空对象。

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

class OwnedStarterDefinition implements StarterDefinition {
  declare readonly [starterDefinitionBrand]: true;
}

export function defineStarter(): StarterDefinition {
  return Object.freeze(new OwnedStarterDefinition());
}

export function defineApplication(options: DefineApplicationOptions): ApplicationDefinition {
  if (!isObject(options)) {
    throw new InvalidApplicationOptionsError([describeValue(options)]);
  }
  if (!Array.isArray(options.starters)) {
    throw new MissingApplicationStartersError([]);
  }
  return Object.freeze(new OwnedApplicationDefinition());
}
