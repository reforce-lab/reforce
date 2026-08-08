import { isObject } from "radashi";
import { afterEach, describe, expect, test } from "vitest";
import { RequestValidationError } from "@/errors";
import { createErrorDispatcher } from "@/execution/error-dispatch";
import { fromStandardRequest } from "@/execution/incoming-request";
import { RequestContextState } from "@/execution/request-context";
import { runWithRequestFields } from "@/execution/request-fields";
import { ConflictError, defineHttpError, HttpError } from "@/http-errors";
import { readRouteBody, readRouteJson } from "../support/route-response";

function requestContext(): RequestContextState {
  return new RequestContextState({
    incoming: fromStandardRequest(new Request("https://reforce.test/users")),
    method: "GET",
    path: "/users",
    params: {},
    meta: {},
  });
}

describe("createErrorDispatcher", () => {
  test("the first handler that returns a Response takes over", async () => {
    const dispatch = createErrorDispatcher([
      { handler: { handle: () => new Response("first", { status: 418 }) } },
      {
        handler: {
          handle: () => {
            throw new Error("second must not run");
          },
        },
      },
    ]);

    const response = await dispatch(new Error("boom"), requestContext());

    expect(response.status).toBe(418);
    expect(await readRouteBody(response)).toBe("first");
  });

  test("a throwing handler passes the thrown error to the next handler", async () => {
    const seen: unknown[] = [];
    const replaced = new Error("replaced");
    const dispatch = createErrorDispatcher([
      {
        handler: {
          handle: (error: unknown) => {
            seen.push(error);
            throw replaced;
          },
        },
      },
      {
        handler: {
          handle: (error: unknown) => {
            seen.push(error);
            return new Response(undefined, { status: 502 });
          },
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
    expect(await readRouteJson(response)).toEqual({
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

    const body = await readRouteBody(response);
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
    expect(await readRouteJson(response)).toEqual({
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
    const body: unknown = await readRouteJson(response);

    expect(records).toHaveLength(1);
    expect(records[0]?.fields?.errorId).toBe(
      isObject(body) ? Reflect.get(body, "errorId") : undefined,
    );
  });

  // 栈里有源码路径、依赖版本、有时还有拼进消息的参数值。响应只带 errorId，栈只进日志。
  test("keeps the stack out of the response body", async () => {
    const dispatch = createErrorDispatcher([]);

    const response = await dispatch(new Error("boom with a secret"), requestContext());
    const text = await readRouteBody(response);

    expect(text).not.toContain("boom with a secret");
    expect(text).not.toContain("at ");
  });

  // #303/#250 拍板:errorId 原样保留,unhandled error 日志同时带 requestId——500 响应头带
  // requestId、body 带 errorId,这条记录把两串字符自动关联。body 形状零改动。
  test("the unhandled-error record joins requestId and errorId; the body shape is unchanged", async () => {
    const records: { fields: Readonly<Record<string, unknown>> | undefined }[] = [];
    const dispatch = createErrorDispatcher([], {
      error: (fields) => records.push({ fields }),
    });

    const response = await runWithRequestFields(
      { method: "GET", path: "/users", requestId: "rid-1" },
      () => dispatch(new Error("boom"), requestContext()),
    );

    expect(records[0]?.fields).toMatchObject({ requestId: "rid-1", errorId: expect.any(String) });
    expect(await readRouteJson(response)).toEqual({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      errorId: expect.any(String),
    });
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
    expect(await readRouteJson(response)).toEqual({
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

    expect(await readRouteJson(response)).toEqual({
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

    expect(await readRouteBody(response)).not.toContain("retry with a different name");
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

    expect(await readRouteJson(response)).toMatchObject({ status: 599, title: "Error" });
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

// dev 错误页协商矩阵的 JSON 象限（#279）：三条都不该触发渲染器加载，这里保持纯单测；
// 命中渲染的象限连同注入/降级/隔离在 it/dev-error-page.spec.ts（渲染要读模板资产，属 fs 行为）。
describe("dev error page negotiation keeps the JSON path", () => {
  // 键字面量与 error-dispatch.ts 读取侧、runtime dev-runtime.ts 设置侧一致。
  const flagKey = Symbol.for("reforce.devErrorPage");

  afterEach(() => {
    Reflect.deleteProperty(globalThis, flagKey);
  });

  function negotiatedContext(
    input: { readonly method?: "GET" | "HEAD"; readonly accept?: string } = {},
  ): RequestContextState {
    const request = new Request("https://reforce.test/users", {
      method: input.method ?? "GET",
      ...(input.accept === undefined ? {} : { headers: { accept: input.accept } }),
    });
    return new RequestContextState({
      incoming: fromStandardRequest(request),
      method: input.method ?? "GET",
      path: "/users",
      params: {},
      meta: {},
    });
  }

  // 默认关死：不经 dev-runtime 设旗标，浏览器直接戳 dev 端口拿到的仍是与生产逐字节同形的
  // problem+json——第三方打包器不折叠 NODE_ENV、生产误设 NODE_ENV=development 由此构造性安全。
  test("without the flag an html Accept gets the byte-identical problem+json", async () => {
    const dispatch = createErrorDispatcher([]);
    const error = new ConflictError("taken");

    const plain = await dispatch(error, negotiatedContext());
    const negotiated = await dispatch(error, negotiatedContext({ accept: "text/html,*/*" }));

    expect(negotiated.status).toBe(plain.status);
    expect(await readRouteBody(negotiated)).toBe(await readRouteBody(plain));
    expect([...negotiated.headers.entries()]).toEqual([...plain.headers.entries()]);
  });

  test("with the flag a non-html Accept keeps the JSON path", async () => {
    Reflect.set(globalThis, flagKey, true);
    const dispatch = createErrorDispatcher([]);

    const response = await dispatch(
      new ConflictError("taken"),
      negotiatedContext({ accept: "*/*" }),
    );

    expect(response.headers.get("content-type")).toBe("application/problem+json");
  });

  // HEAD 的响应体不会被读，渲染是纯浪费；协商在 wantsHtml 里对 HEAD 短路。
  test("a HEAD request never gets the html page", async () => {
    Reflect.set(globalThis, flagKey, true);
    const dispatch = createErrorDispatcher([]);

    const response = await dispatch(
      new ConflictError("taken"),
      negotiatedContext({ method: "HEAD", accept: "text/html" }),
    );

    expect(response.headers.get("content-type")).toBe("application/problem+json");
  });
});

// 类型化处理器(RFC 0012 S3,#275):accepts 是 instanceof 闸,status/encode 是非 Response
// 返回值的编码出线路径。
describe("createErrorDispatcher typed entries", () => {
  class OrderRejected extends Error {}
  class QuotaExceeded extends Error {}

  test("an accepts gate skips errors that are not instances of the class", async () => {
    const seen: unknown[] = [];
    const dispatch = createErrorDispatcher([
      {
        handler: {
          handle: (error: unknown) => {
            seen.push(error);
            return new Response("order", { status: 409 });
          },
        },
        accepts: OrderRejected,
      },
    ]);

    const missed = await dispatch(new QuotaExceeded("quota"), requestContext());
    const hit = await dispatch(new OrderRejected("order"), requestContext());

    expect(missed.status).toBe(500);
    expect(hit.status).toBe(409);
    expect(seen).toHaveLength(1);
  });

  test("a subclass instance passes the accepts gate of its base class", async () => {
    class SpecialOrderRejected extends OrderRejected {}
    const dispatch = createErrorDispatcher([
      {
        handler: { handle: () => new Response("order", { status: 409 }) },
        accepts: OrderRejected,
      },
    ]);

    const response = await dispatch(new SpecialOrderRejected("sub"), requestContext());

    expect(response.status).toBe(409);
  });

  test("a non-Response return with a declared status is encoded onto the wire", async () => {
    const dispatch = createErrorDispatcher([
      {
        handler: { handle: () => ({ code: "ORDER_REJECTED", orderId: 42n }) },
        accepts: OrderRejected,
        status: 409,
        encode: (value: unknown) => ({
          code: Reflect.get(Object(value), "code"),
          orderId: String(Reflect.get(Object(value), "orderId")),
        }),
      },
    ]);

    const response = await dispatch(new OrderRejected("boom"), requestContext());

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await readRouteJson(response)).toEqual({ code: "ORDER_REJECTED", orderId: "42" });
  });

  test("a status without an encoder serializes the raw return value", async () => {
    const dispatch = createErrorDispatcher([
      {
        handler: { handle: () => ({ code: "TEAPOT" }) },
        status: 418,
      },
    ]);

    const response = await dispatch(new Error("boom"), requestContext());

    expect(response.status).toBe(418);
    expect(await readRouteJson(response)).toEqual({ code: "TEAPOT" });
  });

  test("a match-all handler returning a non-Response escalates instead of taking over", async () => {
    const seen: unknown[] = [];
    const dispatch = createErrorDispatcher([
      { handler: { handle: () => ({ leaked: true }) } },
      {
        handler: {
          handle: (error: unknown) => {
            seen.push(error);
            throw error;
          },
        },
      },
    ]);

    const response = await dispatch(new Error("boom"), requestContext());

    // 升级后的错误是 ResponseSerializationError,最终落 500 兜底;原错误不再保留(换错即升级)。
    expect(response.status).toBe(500);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Error);
    expect(String(Reflect.get(Object(seen[0]), "message"))).toContain("@ResponseStatus");
  });

  test("an escalated error is re-gated by later typed handlers", async () => {
    const dispatch = createErrorDispatcher([
      { handler: { handle: () => ({ leaked: true }) } },
      {
        handler: { handle: () => new Response("order-only", { status: 409 }) },
        accepts: OrderRejected,
      },
    ]);

    const response = await dispatch(new OrderRejected("boom"), requestContext());

    // 第一条 match-all 把 OrderRejected 换成了 ResponseSerializationError,第二条 typed
    // 处理器的 accepts 闸不再放行——最终 500 兜底。
    expect(response.status).toBe(500);
  });
});
