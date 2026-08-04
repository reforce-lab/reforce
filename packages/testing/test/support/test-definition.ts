import type {
  GeneratedApplicationDefinition,
  GeneratedBeanRegistration,
  GeneratedDependency,
  GeneratedDependencyMode,
  GeneratedSourceReference,
} from "@reforce/context/generated-runtime";

export function testSource(name: string): GeneratedSourceReference {
  return {
    file: `src/${name}.ts`,
    start: { offset: 0, line: 0, character: 0 },
    end: { offset: name.length, line: 0, character: name.length },
  };
}

export function testDependency(
  parameterIndex: number,
  targetId: string,
  mode: GeneratedDependencyMode,
): GeneratedDependency {
  return {
    parameterIndex,
    targetId,
    mode,
    source: testSource(`parameter-${parameterIndex}`),
  };
}

export function testDefinition(
  registrations: readonly GeneratedBeanRegistration[],
): GeneratedApplicationDefinition {
  return {
    schemaVersion: 2,
    configs: [],
    registrations,
    plans: {
      constructionOrder: registrations.map((registration) => registration.id),
      startActionOrder: registrations.flatMap((registration) =>
        registration.kind === "class" && registration.hooks.start ? [registration.id] : [],
      ),
      cleanupActionOrder: registrations.flatMap((registration) => {
        if (registration.kind === "class" && registration.hooks.close) {
          return [registration.id];
        }
        if (registration.kind === "factory" && registration.dispose) {
          return [registration.id];
        }
        return [];
      }),
    },
  };
}
