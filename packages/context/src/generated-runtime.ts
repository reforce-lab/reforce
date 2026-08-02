import { readBeanDefinitionOptions } from "./bean-declaration";
import { createApplicationContext as createRuntimeApplicationContext } from "./create-application-context";
import type {
  GeneratedApplicationDefinition,
  GeneratedClassRegistration,
  GeneratedFactoryBeanInput,
  GeneratedFactoryRegistration,
} from "./generated-contracts";
import {
  snapshotApplicationDefinition,
  snapshotClassRegistration,
  snapshotFactoryRegistration,
} from "./generated-validation";
import type { ApplicationContext } from "./public-types";

export type {
  GeneratedApplicationDefinition,
  GeneratedBeanId,
  GeneratedBeanRegistration,
  GeneratedClassHooks,
  GeneratedClassRegistration,
  GeneratedDependency,
  GeneratedDependencyMode,
  GeneratedExecutionPlans,
  GeneratedFactoryBeanInput,
  GeneratedFactoryRegistration,
  GeneratedResolver,
  GeneratedSourcePosition,
  GeneratedSourceReference,
} from "./generated-contracts";

export function classBean<T extends object>(
  input: Omit<GeneratedClassRegistration<T>, "kind">,
): GeneratedClassRegistration<T> {
  return snapshotClassRegistration({ kind: "class", ...input });
}

export function factoryBean<T extends object>(
  input: GeneratedFactoryBeanInput<T>,
): GeneratedFactoryRegistration<T> {
  const options = readBeanDefinitionOptions(input.definition);
  return snapshotFactoryRegistration({
    kind: "factory",
    id: input.id,
    source: input.source,
    definition: input.definition,
    dependencies: [],
    create: options.create,
    ...(options.dispose ? { dispose: options.dispose } : {}),
  });
}

export function createApplicationContext(
  definition: GeneratedApplicationDefinition,
): ApplicationContext {
  return createRuntimeApplicationContext(snapshotApplicationDefinition(definition));
}
