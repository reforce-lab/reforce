import { describe, expect, test } from "bun:test";
import type {
  GeneratedClassHooks,
  GeneratedFactoryRegistration,
} from "#internal/generated-contracts";
import { factoryBean } from "#internal/generated-runtime";
import { defineBean, Injectable, Primary, Qualifier, ReforceRuntimeError } from "#internal/index";

interface BaseResource {
  readonly base: true;
}

interface SpecializedResource extends BaseResource {
  readonly specialized: true;
}

function verifyGeneratedCallbackInputsAreContravariant(): void {
  const specializedOnly = (_instance: SpecializedResource): void => undefined;

  const hooks: GeneratedClassHooks<BaseResource> = {
    // @ts-expect-error A generated hook must accept every instance promised by its registration.
    start: specializedOnly,
  };
  // @ts-expect-error A generated disposer must accept every instance promised by its registration.
  const dispose: NonNullable<GeneratedFactoryRegistration<BaseResource>["dispose"]> =
    specializedOnly;

  void hooks;
  void dispose;
}

void verifyGeneratedCallbackInputsAreContravariant;

const source = {
  file: "src/resource.ts",
  start: { offset: 0, line: 0, character: 0 },
  end: { offset: 8, line: 0, character: 8 },
} as const;

describe("public bean declarations", () => {
  test("decorators preserve the decorated class", () => {
    @Injectable()
    @Primary()
    @Qualifier("main")
    class Resource {}

    const instance = new Resource();

    expect(instance).toBeInstanceOf(Resource);
  });

  test("a factory remains dormant until its registration is invoked", () => {
    let creations = 0;
    const definition = defineBean({
      create: () => {
        creations += 1;
        return { connected: true };
      },
    });

    const registration = factoryBean({
      id: "src/resource.ts#resource",
      source,
      definition,
    });

    expect(creations).toBe(0);
    expect(registration.create()).toEqual({ connected: true });
    expect(creations).toBe(1);
  });

  test("a foreign factory definition is rejected", () => {
    const definition = Object.freeze({});

    const createRegistration = () =>
      Reflect.apply(factoryBean, undefined, [
        {
          id: "src/resource.ts#resource",
          source,
          definition,
        },
      ]);

    expect(createRegistration).toThrow("defineBean");
  });

  test("runtime errors retain stable names", () => {
    class ExampleError extends ReforceRuntimeError<"APPLICATION_CONTEXT_STATE"> {
      readonly code = "APPLICATION_CONTEXT_STATE" as const;

      constructor() {
        super("example");
      }
    }

    const error = new ExampleError();

    expect(error.name).toBe("ExampleError");
    expect(error.message).toBe("example");
    expect(error.code).toBe("APPLICATION_CONTEXT_STATE");
  });
});
