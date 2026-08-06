import { describe, expect, test } from "vitest";
import { RequestValidationError } from "@/errors";
import { createErrorDispatcher } from "@/execution/error-dispatch";
import { RequestContextState } from "@/execution/request-context";

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
      error: "request validation failed",
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

  test("any other unhandled error falls back to an empty 500", async () => {
    const dispatch = createErrorDispatcher([]);

    const response = await dispatch(new Error("boom"), requestContext());

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
  });
});
