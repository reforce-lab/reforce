import { isReforceError, ReforceError } from "@reforce/core";
import { describe, expect, test } from "vitest";
import { webErrorCodes } from "@/error-codes";
import {
  BadRequestError,
  ConflictError,
  defineHttpError,
  ForbiddenError,
  HttpError,
  NotFoundError,
  UnauthorizedError,
} from "@/http-errors";

// 面向用户的异常原语（ADR 0013 决议 6，#294）。此前这一层完全空白，模板只能教用户自己造裸
// `extends Error` 再手维护一张状态码查表。
describe("the built-in HTTP error subclasses", () => {
  const cases = [
    [BadRequestError, 400, "WEB_BAD_REQUEST"],
    [UnauthorizedError, 401, "WEB_UNAUTHORIZED"],
    [ForbiddenError, 403, "WEB_FORBIDDEN"],
    [NotFoundError, 404, "WEB_NOT_FOUND"],
    [ConflictError, 409, "WEB_CONFLICT"],
  ] as const;

  for (const [Subclass, status, code] of cases) {
    test(`${Subclass.name} carries status ${status}`, () => {
      expect(new Subclass("nope").status).toBe(status);
    });

    test(`${Subclass.name} carries ${code}`, () => {
      expect(new Subclass("nope").code).toBe(code);
    });

    test(`${Subclass.name} declares its code in the package code table`, () => {
      expect(webErrorCodes).toContain(code);
    });
  }

  test("keeps the message the caller wrote", () => {
    expect(new NotFoundError("no greeting with id 7").message).toBe("no greeting with id 7");
  });

  test("carries an optional cause", () => {
    const cause = new Error("row missing");

    expect(new NotFoundError("gone", { cause }).cause).toBe(cause);
  });
});

// 进谱系是这一支能被兜底拦截器放行、能被 reporter 取码取 help 的前提。
describe("the HTTP subtree joins the ReforceError lineage", () => {
  test("an HttpError is recognized by the lineage guard", () => {
    expect(isReforceError(new NotFoundError("gone"))).toBe(true);
  });

  test("an HttpError is an instance of the shared root", () => {
    expect(new NotFoundError("gone")).toBeInstanceOf(ReforceError);
  });

  // 构造是公开的，与谱系里其它错误（只能由框架抛）相反——这一支的意义就是让用户 throw。
  test("the base class is publicly constructible", () => {
    const error = new HttpError({ status: 418, code: "TEAPOT", message: "short and stout" });

    expect(error.status).toBe(418);
  });
});

describe("defineHttpError", () => {
  const GreetingAlreadyExists = defineHttpError<[name: string]>(
    "GREETING_ALREADY_EXISTS",
    "已经有名为 %s 的问候语了。",
    409,
    { help: "改个名字，或者先删掉旧的那条。" },
  );

  test("renders %s slots in order", () => {
    expect(new GreetingAlreadyExists(["Lynch"]).message).toBe("已经有名为 Lynch 的问候语了。");
  });

  test("carries the code the caller chose", () => {
    expect(new GreetingAlreadyExists(["Lynch"]).code).toBe("GREETING_ALREADY_EXISTS");
  });

  test("carries the status the caller chose", () => {
    expect(new GreetingAlreadyExists(["Lynch"]).status).toBe(409);
  });

  test("carries the help declared once at definition time", () => {
    expect(new GreetingAlreadyExists(["Lynch"]).help).toBe("改个名字，或者先删掉旧的那条。");
  });

  test("accepts a per-throw cause", () => {
    const cause = new Error("unique violation");

    expect(new GreetingAlreadyExists(["Lynch"], { cause }).cause).toBe(cause);
  });

  test("produces errors that are instances of HttpError", () => {
    expect(new GreetingAlreadyExists(["Lynch"])).toBeInstanceOf(HttpError);
  });

  // 用户起的码不进框架的码表——那个命名空间是用户的，框架不该占。
  test("does not register the user's code in the framework code table", () => {
    expect(webErrorCodes).not.toContain("GREETING_ALREADY_EXISTS");
  });
});
