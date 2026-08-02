import type {
  GeneratedApplicationDefinition,
  GeneratedBeanRegistration,
  GeneratedDependency,
  GeneratedDependencyMode,
  GeneratedSourceReference,
} from "@/generated-runtime";

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
  input: {
    readonly constructionOrder?: readonly string[];
    readonly startActionOrder?: readonly string[];
    readonly cleanupActionOrder?: readonly string[];
  } = {},
): GeneratedApplicationDefinition {
  return {
    schemaVersion: 1,
    registrations,
    plans: {
      constructionOrder:
        input.constructionOrder ?? registrations.map((registration) => registration.id),
      startActionOrder:
        input.startActionOrder ??
        registrations.flatMap((registration) =>
          registration.kind === "class" && registration.hooks.start ? [registration.id] : [],
        ),
      cleanupActionOrder:
        input.cleanupActionOrder ??
        registrations.flatMap((registration) => {
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
