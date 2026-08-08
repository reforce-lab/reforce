import { isObject } from "radashi";
import { afterEach, describe, expect, test } from "vitest";
import { RequestValidationError } from "@/errors";
import { createErrorDispatcher } from "@/execution/error-dispatch";
import { fromStandardRequest } from "@/execution/incoming-request";
import { RequestContextState } from "@/execution/request-context";
import { runWithRequestFields } from "@/execution/request-fields";
import { ConflictError } from "@/http-errors";
import { metaLookup } from "@/routing/route-marker";
import { readRouteBody, readRouteJson } from "../test/support/route-response";

// dev 错误页真渲染（#279）：渲染器要读 youch 的模板资产，属 filesystem 行为，所以在 it/。
// 协商矩阵里不触发渲染的 JSON 象限在 test/execution/error-dispatch.spec.ts。
//
// 断言只钉自有注入值（code、explain 命令串、requestId、issue message……），不断言 youch 的
// DOM 结构——模板是上游的，钉它等于把上游重构变成本仓的红灯。

const flagKey = Symbol.for("reforce.devErrorPage");

afterEach(() => {
  Reflect.deleteProperty(globalThis, flagKey);
});

function enablePage(): void {
  Reflect.set(globalThis, flagKey, true);
}

function htmlContext(
  input: {
    readonly url?: string;
    readonly params?: Readonly<Record<string, string>>;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): RequestContextState {
  const request = new Request(input.url ?? "https://reforce.test/users/42", {
    headers: { accept: "text/html,application/xhtml+xml", ...input.headers },
  });
  return new RequestContextState({
    incoming: fromStandardRequest(request),
    method: "GET",
    path: "/users/:id",
    params: input.params ?? { id: "42" },
    meta: metaLookup({}),
  });
}

describe("dev error page rendering", () => {
  test("an HttpError renders html at its own status with code and explain command", async () => {
    enablePage();
    const dispatch = createErrorDispatcher([]);

    const response = await dispatch(new ConflictError("greeting already exists"), htmlContext());
    const page = await readRouteBody(response);

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page).toContain("WEB_CONFLICT");
    expect(page).toContain("reforce explain WEB_CONFLICT");
    expect(page).toContain("/users/:id");
  });

  test("the html response carries the hardening headers with a per-response nonce", async () => {
    enablePage();
    const dispatch = createErrorDispatcher([]);

    const response = await dispatch(new ConflictError("taken"), htmlContext());

    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/^default-src 'none'; style-src 'nonce-[0-9a-f-]+'; script-src 'nonce-/u);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("accept");
    const body = await readRouteBody(response);
    expect(response.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(body).length),
    );
  });

  test("a validation failure renders the issue messages at status 400", async () => {
    enablePage();
    const dispatch = createErrorDispatcher([]);
    const error = new RequestValidationError({
      source: "body",
      issues: [{ message: "name is required", path: ["name"] }],
    });

    const response = await dispatch(error, htmlContext());
    const page = await readRouteBody(response);

    expect(response.status).toBe(400);
    expect(page).toContain("name is required");
    expect(page).toContain("reforce explain REQUEST_VALIDATION_FAILED");
  });

  test("a 500 page shows the same errorId the log record carries", async () => {
    enablePage();
    const records: { fields: Readonly<Record<string, unknown>> | undefined }[] = [];
    const dispatch = createErrorDispatcher([], {
      error: (fields) => records.push({ fields }),
    });

    const response = await runWithRequestFields(
      { method: "GET", path: "/users/:id", requestId: "rid-dev-page" },
      () => dispatch(new Error("boom"), htmlContext()),
    );
    const page = await readRouteBody(response);

    expect(response.status).toBe(500);
    const errorId = records[0]?.fields?.errorId;
    expect(typeof errorId).toBe("string");
    expect(page).toContain(String(errorId));
    expect(page).toContain("rid-dev-page");
  });

  test("a user error handler still takes over before the page", async () => {
    enablePage();
    const dispatch = createErrorDispatcher([
      { handler: { handle: () => new Response("mine", { status: 418 }) } },
    ]);

    const response = await dispatch(new Error("boom"), htmlContext());

    expect(response.status).toBe(418);
    expect(await readRouteBody(response)).toBe("mine");
  });
});

describe("dev error page injection resistance", () => {
  // 模板对 message/值位转义、hint 通道被封死之后，页面上不允许出现任何未转义的攻击载荷。
  // 载荷运行期拼接，不写成字面量：栈顶帧的源码会被渲染进页面，字面量会以「测试源码」的
  // 身份在场（转义形态），让 toContain("&lt;script&gt;") 这类断言失去指向性。
  const payload = ["<scr", 'ipt>alert("pwned")</scr', "ipt>"].join("");

  test("a params value, header value, message and help never reach the page unescaped", async () => {
    enablePage();
    const dispatch = createErrorDispatcher([]);
    const error = new ConflictError(`taken ${payload}`, { help: `retry ${payload}` });

    const response = await dispatch(
      error,
      htmlContext({
        params: { id: payload },
        headers: { "x-injected": payload },
      }),
    );
    const page = await readRouteBody(response);

    expect(page).not.toContain(payload);
    // 载荷仍要以转义形态在场——「没渲染出来」和「被转义了」是两回事。
    expect(page).toContain("&lt;script&gt;");
  });

  test("credential header values are masked down to their length", async () => {
    enablePage();
    const dispatch = createErrorDispatcher([]);
    // 运行期拼接：错误栈顶帧就是本文件，youch 会把抛错点周围的源码渲染进页面——密钥写成
    // 字面量会以「测试源码」的身份出现在页上，把断言变成误报。
    const secret = `Bearer ${"secret".repeat(4)}`;
    const apiKey = `k-${"42".repeat(3)}`;

    const response = await dispatch(
      new ConflictError("taken"),
      htmlContext({ headers: { authorization: secret, "x-api-key": apiKey } }),
    );
    const page = await readRouteBody(response);

    expect(page).not.toContain(secret);
    expect(page).not.toContain(apiKey);
    expect(page).toContain(`«redacted, ${secret.length} chars»`);
    expect(page).toContain(`«redacted, ${apiKey.length} chars»`);
  });
});

describe("dev error page degradation", () => {
  test("a renderer failure degrades to the sanitized problem+json", async () => {
    enablePage();
    const dispatch = createErrorDispatcher([]);
    // stack 的 getter 抛错是渲染中途的自然故障：解析器读栈时炸，无需 mock 渲染器。
    const error = new Error("boom");
    Object.defineProperty(error, "stack", {
      get() {
        throw new Error("stack is unavailable");
      },
    });

    const response = await dispatch(error, htmlContext());

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(await readRouteJson(response)).toMatchObject({
      status: 500,
      errorId: expect.any(String),
    });
  });

  test("a thrown string still renders a page instead of crashing", async () => {
    enablePage();
    const dispatch = createErrorDispatcher([]);

    const response = await dispatch("plain failure", htmlContext());
    const page = await readRouteBody(response);

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page).toContain("non-Error");
  });

  test("a thrown undefined still renders a page instead of crashing", async () => {
    enablePage();
    const dispatch = createErrorDispatcher([]);

    const response = await dispatch(undefined, htmlContext());

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
});

describe("dev error page isolation", () => {
  // Metadata 是实例态、group() 是合并语义（#279 防线 5）：渲染器必须每错误新建实例，
  // 否则上一请求的 headers 会滚进下一页。
  test("the second render does not leak the first render's header values", async () => {
    enablePage();
    const dispatch = createErrorDispatcher([]);
    const firstOnly = "first-render-unique-value";

    const first = await dispatch(
      new ConflictError("taken"),
      htmlContext({ headers: { "x-first": firstOnly } }),
    );
    const second = await dispatch(new ConflictError("taken"), htmlContext());

    expect(await readRouteBody(first)).toContain(firstOnly);
    expect(await readRouteBody(second)).not.toContain(firstOnly);
  });
});

// 兜底行为的跨表面一致性：page 只改呈现，status/members 判定与 JSON 分支同源。
describe("dev error page status parity", () => {
  test("the html page and the json body agree on the status for every branch", async () => {
    enablePage();
    const dispatch = createErrorDispatcher([]);
    const cases: readonly { readonly error: unknown; readonly status: number }[] = [
      { error: new ConflictError("taken"), status: 409 },
      {
        error: new RequestValidationError({ source: "query", issues: [{ message: "bad" }] }),
        status: 400,
      },
      { error: new Error("boom"), status: 500 },
    ];

    for (const item of cases) {
      const html = await dispatch(item.error, htmlContext());
      const json = await dispatch(item.error, htmlContext({ headers: { accept: "*/*" } }));
      expect(html.status).toBe(item.status);
      expect(json.status).toBe(item.status);
      expect(isObject(await readRouteJson(json))).toBe(true);
    }
  });
});
