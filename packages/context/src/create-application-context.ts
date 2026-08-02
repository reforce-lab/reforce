import { RuntimeApplicationContext } from "./context-runtime";
import type { GeneratedApplicationDefinition } from "./generated-contracts";
import type { ApplicationContext } from "./public-types";

export function createApplicationContext(
  definition: GeneratedApplicationDefinition,
): ApplicationContext {
  return new RuntimeApplicationContext(definition);
}
