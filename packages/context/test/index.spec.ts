import { expect, test } from "bun:test";
import * as generatedRuntime from "@/generated-runtime";
import * as publicContext from "@/index";

test("the root entry exposes only the public programming model", () => {
  expect(Object.keys(publicContext).sort()).toEqual([
    "ApplicationCleanupError",
    "ApplicationContextStateError",
    "ApplicationStartError",
    "BeanCreationError",
    "BeanDisposalError",
    "BeanLifecycleError",
    "EarlyBeanAccessError",
    "Injectable",
    "InvalidGeneratedDefinitionError",
    "Primary",
    "Qualifier",
    "ReforceRuntimeError",
    "UnregisteredBeanTargetError",
    "defineApplication",
    "defineBean",
  ]);
});

test("the generated entry exposes only registration and Context helpers", () => {
  expect(Object.keys(generatedRuntime).sort()).toEqual([
    "classBean",
    "createApplicationContext",
    "factoryBean",
  ]);
});
