import { expect, test } from "vitest";
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
    "ConfigBindingError",
    "EarlyBeanAccessError",
    "Fallback",
    "Injectable",
    "Interceptor",
    "InterceptorReenteredError",
    "InvalidGeneratedDefinitionError",
    "Order",
    "Primary",
    "Qualifier",
    "ReforceError",
    "RequestContextMissingError",
    "RequestScoped",
    "UnregisteredBeanTargetError",
    "coreErrorCodes",
    "defineApplication",
    "defineBean",
    "defineMethodMarker",
    "defineStarter",
    "errors",
    "interceptPhases",
    "isReforceError",
  ]);
});

test("the generated entry exposes only registration and Context helpers", () => {
  expect(Object.keys(generatedRuntime).sort()).toEqual([
    "classBean",
    "configBean",
    "createApplicationContext",
    "factoryBean",
    "invokeIntercepted",
  ]);
});
