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
    "ConfigBindingError",
    "EarlyBeanAccessError",
    "Injectable",
    "Interceptor",
    "InvalidGeneratedDefinitionError",
    "Order",
    "Primary",
    "Qualifier",
    "ReforceRuntimeError",
    "RequestContextMissingError",
    "RequestScoped",
    "TransactionIsolationOnJoinError",
    "TransactionIsolationUnsupportedError",
    "TransactionSavepointUnsupportedError",
    "Transactional",
    "UnregisteredBeanTargetError",
    "activeTransaction",
    "defineApplication",
    "defineBean",
    "defineMethodMarker",
    "interceptPhases",
  ]);
});

test("the generated entry exposes only registration and Context helpers", () => {
  expect(Object.keys(generatedRuntime).sort()).toEqual([
    "TransactionInterceptor",
    "classBean",
    "configBean",
    "createApplicationContext",
    "factoryBean",
    "invokeIntercepted",
  ]);
});
