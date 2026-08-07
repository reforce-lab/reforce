import { isObject } from "radashi";
import { describe, expect, test } from "vitest";
import { RequestValidationError } from "@/errors";
import { createErrorDispatcher } from "@/execution/error-dispatch";
import { RequestContextState } from "@/execution/request-context";
import { ConflictError, defineHttpError, HttpError } from "@/http-errors";

function requestContext(): RequestContextState {
  return new RequestContextState({
    request: new Request("https://reforce.test/users"),
    url: new URL("https://reforce.test/users"),
    method: "GET",
    path: "/users",
    params: {},
    meta: {},
  });
}

describe("createErrorDispatcher", () => {
  test("the first handler that returns a Response takes over", async () => {
    const dispatch = createErrorDispatcher([
      { handle: () => new Response("first", { status: 418 }) },
      {
        handle: () => {
          throw new Error("second must not run");
        },
      },
    ]);

    const response = await dispatch(new Error("boom"), requestContext());

    expect(response.status).toBe(418);
    expect(await response.text()).toBe("first");
  });

  test("a throwing handler passes the thrown error to the next handler", async () => {
    const seen: unknown[] = [];
    const replaced = new Error("replaced");
    const dispatch = createErrorDispatcher([
      {
        handle: (error) => {
          seen.push(error);
          throw replaced;
        },
      },
      {
        handle: (error) => {
          seen.push(error);
          return new Response(undefined, { status: 502 });
        },
      },
    ]);
    const original = new Error("original");

    const response = await dispatch(original, requestContext());

    expect(response.status).toBe(502);
    expect(seen).toEqual([original, replaced]);
  });

  test("an unhandled validation error falls back to a sanitized 400", async () => {
    const dispatch = createErrorDispatcher([]);
    const error = new RequestValidationError({
      source: "body",
      issues: [{ message: "name is required", path: ["name"] }],
    });

    const response = await dispatch(error, requestContext());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      code: "REQUEST_VALIDATION_FAILED",
      source: "body",
      issues: [{ message: "name is required", path: ["name"] }],
    });
  });

  test("the sanitized 400 declares content-length in bytes", async () => {
    const dispatch = createErrorDispatcher([]);
    // issue 文案可以带非 ASCII，长度必须按字节数算
    const error = new RequestValidationError({
      source: "body",
      issues: [{ message: "名称必填", path: ["name"] }],
    });

    const response = await dispatch(error, requestContext());

    const body = await response.clone().text();
    expect(response.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(body).length),
    );
  });

  // C1（RFC 0011，#250）：兜底此前是 `new Response(undefined, { status: 500 })`——错误完全
  // 被吞掉，不打日志，客户端也拿不到任何线索。
  test("any other unhandled error falls back to a 500 carrying an errorId", async () => {
    const dispatch = createErrorDispatcher([]);

    const response = await dispatch(new Error("boom"), requestContext());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      errorId: expect.any(String),
    });
  });

  // 响应体的 errorId 与日志的 errorId 必须是同一个：它们的全部价值就是把用户报的那串字符
  // 和日志里的现场对上。
  test("logs the failure under the same errorId it hands the client", async () => {
    const records: { fields: Readonly<Record<string, unknown>> | undefined }[] = [];
    const dispatch = createErrorDispatcher([], {
      error: (fields) => records.push({ fields }),
    });

    const response = await dispatch(new Error("boom"), requestContext());
    const body: unknown = await response.json();

    expect(records).toHaveLength(1);
    expect(records[0]?.fields?.errorId).toBe(
      isObject(body) ? Reflect.get(body, "errorId") : undefined,
    );
  });

  // 栈里有源码路径、依赖版本、有时还有拼进消息的参数值。响应只带 errorId，栈只进日志。
  test("keeps the stack out of the response body", async () => {
    const dispatch = createErrorDispatcher([]);

    const response = await dispatch(new Error("boom with a secret"), requestContext());
    const text = await response.text();

    expect(text).not.toContain("boom with a secret");
    expect(text).not.toContain("at ");
  });

  test("hands the error object itself to the log under the reserved err field", async () => {
    const failure = new Error("boom");
    const records: { fields: Readonly<Record<string, unknown>> | undefined }[] = [];
    const dispatch = createErrorDispatcher([], {
      error: (fields) => records.push({ fields }),
    });

    await dispatch(failure, requestContext());

    expect(records[0]?.fields?.err).toBe(failure);
  });

  // 决议 6（#294）：异常自己携带状态码与码，用户不必为此写 handler。
  test("an HttpError becomes a problem+json response at its own status", async () => {
    const dispatch = createErrorDispatcher([]);

    const response = await dispatch(new ConflictError("greeting already exists"), requestContext());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "greeting already exists",
      code: "WEB_CONFLICT",
    });
  });

  test("a defineHttpError class carries the user's own code", async () => {
    const GreetingAlreadyExists = defineHttpError<[name: string]>(
      "GREETING_ALREADY_EXISTS",
      "已经有名为 %s 的问候语了。",
      409,
    );
    const dispatch = createErrorDispatcher([]);

    const response = await dispatch(new GreetingAlreadyExists(["Lynch"]), requestContext());

    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "已经有名为 Lynch 的问候语了。",
      code: "GREETING_ALREADY_EXISTS",
    });
  });

  // help 是给开发者的下一步指引，不是给调用方的：它进日志与 CLI 呈现，不进 HTTP 响应。
  test("keeps an HttpError's help out of the response body", async () => {
    const dispatch = createErrorDispatcher([]);
    const error = new ConflictError("taken", { help: "retry with a different name." });

    const response = await dispatch(error, requestContext());

    expect(await response.text()).not.toContain("retry with a different name");
  });

  // RFC 9457 要求错误响应用这个媒体类型，客户端据它判断「这是一个问题详情文档」。
  test("labels every framework error response as problem+json", async () => {
    const dispatch = createErrorDispatcher([]);

    const response = await dispatch(new Error("boom"), requestContext());

    expect(response.headers.get("content-type")).toBe("application/problem+json");
  });

  // defineHttpError 允许任意状态码，自建 title 映射表必然覆盖不全。
  test("falls back to a generic title for a status with no standard phrase", async () => {
    const Odd = defineHttpError("ODD", "odd.", 599);
    const dispatch = createErrorDispatcher([]);

    const response = await dispatch(new Odd([]), requestContext());

    expect(await response.json()).toMatchObject({ status: 599, title: "Error" });
  });

  // 框架契约被违反不是「改请求就能好」，因此不映射成 4xx。
  test("leaves a non-HttpError framework error on the 500 path", async () => {
    const dispatch = createErrorDispatcher([]);

    const response = await dispatch(
      new HttpError({ status: 418, code: "X", message: "m" }),
      requestContext(),
    );

    expect(response.status).toBe(418);
  });

  // dispatchError 永不 reject 是适配器契约的一部分；logger 是用户的，可能抛。
  test("still answers when the logger itself throws", async () => {
    const dispatch = createErrorDispatcher([], {
      error: () => {
        throw new Error("logger exploded");
      },
    });

    const response = await dispatch(new Error("boom"), requestContext());

    expect(response.status).toBe(500);
  });
});
