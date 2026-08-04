import { readBeanDefinitionOptions } from "@/bean-declaration";
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
  GeneratedClassHooks,
  GeneratedClassRegistration,
  GeneratedConfigBinding,
  GeneratedConfigBindingOutcome,
  GeneratedConfigRegistration,
  GeneratedDependency,
  GeneratedDependencyMode,
  GeneratedExecutionPlans,
  GeneratedFactoryBeanInput,
  GeneratedFactoryRegistration,
  GeneratedResolver,
  GeneratedSourcePosition,
  GeneratedSourceReference,
} from "@/generated/contracts";
export type { ConfigBindingIssue };

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
    dispose: options.dispose,
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
