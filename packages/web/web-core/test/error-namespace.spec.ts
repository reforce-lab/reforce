import { expect, test } from "vitest";
import { errors } from "@/index";

// 同 @reforce/core 的那份（ADR 0013 决议 8，#296）：只收能 instanceof 的错误类。
// HttpError 与五个高频子类在根入口与命名空间里都在——用户 throw 走根入口，catch 走命名空间。
test("the errors namespace exposes only catchable error classes", () => {
  expect(Object.keys(errors).sort()).toEqual([
    "BadRequestError",
    "ConflictError",
    "ForbiddenError",
    "HttpError",
    "InvalidRouteTableError",
    "MiddlewareReenteredError",
    "NotFoundError",
    "RequestValidationError",
    "ResponseSerializationError",
    "UnauthorizedError",
  ]);
});

test("a user-thrown HTTP error is an instance of its namespace entry", () => {
  expect(new errors.NotFoundError("gone")).toBeInstanceOf(errors.HttpError);
});
