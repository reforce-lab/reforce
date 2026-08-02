import { RuntimeApplicationContext } from "#internal/context-runtime";
import type { GeneratedApplicationDefinition } from "#internal/generated-contracts";
import type { ApplicationContext } from "#internal/public-types";

export function createApplicationContext(
  definition: GeneratedApplicationDefinition,
): ApplicationContext {
  return new RuntimeApplicationContext(definition);
}
