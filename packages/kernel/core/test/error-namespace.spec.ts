import { expect, test } from "vitest";
import { errors } from "@/index";

// `errors` 命名空间（ADR 0013 决议 8，#296）：用途只有 `err instanceof errors.X`，因此它只收
// 能 instanceof 的错误类——基类、守卫、码表、工厂都不在里面。
test("the errors namespace exposes only catchable error classes", () => {
  expect(Object.keys(errors).sort()).toEqual([
    "ApplicationCleanupError",
    "ApplicationContextStateError",
    "ApplicationStartError",
    "BeanCreationError",
    "BeanDisposalError",
    "BeanLifecycleError",
    "ConfigBindingError",
    "EarlyBeanAccessError",
    "InterceptorReenteredError",
    "InvalidGeneratedDefinitionError",
    "RequestContextMissingError",
    "UnregisteredBeanTargetError",
  ]);
});

test("a framework error is an instance of its namespace entry", () => {
  expect(new errors.UnregisteredBeanTargetError(class Absent {})).toBeInstanceOf(
    errors.UnregisteredBeanTargetError,
  );
});
