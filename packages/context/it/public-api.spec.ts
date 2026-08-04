import { describe, expect, test } from "bun:test";
import type {
  GeneratedBeanRegistration,
  GeneratedClassHooks,
  GeneratedFactoryRegistration,
} from "@/generated/contracts";
import { factoryBean } from "@/generated-runtime";
import { defineBean, Injectable, Order, Primary, Qualifier, ReforceRuntimeError } from "@/index";

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

// The erased union promises nothing about instance types, so its callback inputs stay
// pinned to `never`. Widening them would silently let a caller feed any object to a
// hook written for a specific class; tsc reports these directives as unused if that
// happens (Issue #106).
function verifyErasedRegistrationsHideTheirInstanceType(
  registration: GeneratedBeanRegistration,
): void {
  if (registration.kind === "class") {
    // @ts-expect-error An erased registration promises nothing about its instance type.
    registration.hooks.start?.({});
    return;
  }
  // @ts-expect-error An erased registration promises nothing about its instance type.
  registration.dispose?.({});
}

void verifyErasedRegistrationsHideTheirInstanceType;

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
    @Order(1)
    class Resource {}

    const instance = new Resource();

    expect(instance).toBeInstanceOf(Resource);
  });

  test("Order rejects a non-integer argument at declaration time", () => {
    expect(() => Reflect.apply(Order, undefined, ["first"])).toThrow(TypeError);
    expect(() => Reflect.apply(Order, undefined, [1.5])).toThrow(TypeError);
    expect(() => Order(-1)).not.toThrow();
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
