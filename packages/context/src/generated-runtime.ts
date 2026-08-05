import { beanDefinitionScope, readBeanDefinitionOptions } from "@/bean-declaration";
import type { ConfigBindingIssue } from "@/errors";
import type {
  GeneratedApplicationDefinition,
  GeneratedClassRegistration,
  GeneratedConfigRegistration,
  GeneratedFactoryBeanInput,
  GeneratedFactoryRegistration,
} from "@/generated/contracts";
import {
  snapshotApplicationDefinition,
  snapshotClassRegistration,
  snapshotConfigRegistration,
  snapshotFactoryRegistration,
} from "@/generated/validation";
import type { ApplicationContext } from "@/public-types";
import { RuntimeApplicationContext } from "@/runtime/context";

export type {
  GeneratedApplicationDefinition,
  GeneratedBeanId,
  GeneratedBeanRegistration,
  GeneratedBeanScope,
  GeneratedClassHooks,
  GeneratedClassRegistration,
  GeneratedCollectionDependency,
  GeneratedCollectionMember,
  GeneratedCollectionMemberMode,
  GeneratedConfigBinding,
  GeneratedConfigBindingOutcome,
  GeneratedConfigRegistration,
  GeneratedDependency,
  GeneratedDependencyMode,
  GeneratedExecutionPlans,
  GeneratedFactoryBeanInput,
  GeneratedFactoryRegistration,
  GeneratedResolver,
  GeneratedSingleDependency,
  GeneratedSourcePosition,
  GeneratedSourceReference,
} from "@/generated/contracts";
export {
  type GeneratedInterceptorEntry,
  type GeneratedMethodChain,
  invokeIntercepted,
} from "@/interception/invoke";
export type { ConfigBindingIssue };

// scope 缺省即 singleton：既有手写注册面不被 v4 强制打扰，生成物则总是显式写 scope。
export function classBean<T extends object>(
  input: Omit<GeneratedClassRegistration<T>, "kind" | "scope"> & {
    readonly scope?: GeneratedClassRegistration<T>["scope"];
  },
): GeneratedClassRegistration<T> {
  return snapshotClassRegistration({ kind: "class", ...input, scope: input.scope ?? "singleton" });
}

export function factoryBean<T extends object>(
  input: GeneratedFactoryBeanInput<T>,
): GeneratedFactoryRegistration<T> {
  // 工厂的 scope 由 defineBean 选项自证：声明字面量既是编译输入也是运行时输入，无从错位。
  const options = readBeanDefinitionOptions(input.definition);
  return snapshotFactoryRegistration({
    kind: "factory",
    id: input.id,
    source: input.source,
    scope: beanDefinitionScope(options),
    definition: input.definition,
    dependencies: [],
    create: options.create,
    dispose: "dispose" in options ? options.dispose : undefined,
  });
}

export function configBean<T extends object>(
  input: Omit<GeneratedConfigRegistration<T>, "kind">,
): GeneratedConfigRegistration<T> {
  return snapshotConfigRegistration({ kind: "config", ...input });
}

export function createApplicationContext(
  definition: GeneratedApplicationDefinition,
): ApplicationContext {
  return new RuntimeApplicationContext(snapshotApplicationDefinition(definition));
}
