import type { PreparedRoute, WebApplication } from "@/adapter";
import { fromStandardRequest } from "@/execution/incoming-request";
import { RequestContextState } from "@/execution/request-context";
import { ResponseHeaders } from "@/execution/response-headers";
import { absorbResponse, type RouteOutcome, respond } from "@/execution/route-response";
import { createSlotExecutor } from "@/execution/slot-execution";
import type { HttpMethod } from "@/routing/vocabulary";

// 引擎适配器一致性套件（#234）：WebEngineAdapter 的行为契约（见 adapter.ts）在每个引擎上都必须成立。
// 每条断言都对应一个在真实引擎上实测到的差异或缺陷，不是凭空罗列的清单——引擎之间"看起来
// 都能跑"，差别全在这些边角上。
//
// 不 import vitest：那样 dist 里就带上 vitest 的 import，@reforce/web-core 得把它从 devDependency
// 提成 peer，为了一个测试面污染整个依赖图。改为返回用例数组，由调用方自己套 describe/test：
//
//   for (const item of adapterConformanceCases({ name: "node", start })) {
//     test(item.name, () => item.run());
//   }
//
// 同理不用 expect：本文件只抛 Error，任何 runner 都能消费。

export interface AdapterConformanceServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

export interface AdapterConformanceOptions {
  /** 引擎名，仅用于失败信息定位。 */
  readonly name: string;
  /** 起一个监听临时端口的服务，消费给定的 WebApplication。 */
  start(application: WebApplication): Promise<AdapterConformanceServer>;
}

export interface AdapterConformanceCase {
  readonly name: string;
  run(): Promise<void>;
}

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    fail(message);
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    fail(`${label}: expected ${right}, got ${left}`);
  }
}

// 用例的 handler 写成返回标准 Response 是有意的——它们扮演的正是用户 handler 走逃生口那条
// 路。真实管道里那个 Response 会被 serializeResponse 吸收，所以这里也吸收一次，否则套件
// 测的就不是引擎真正会收到的东西。
function route(
  method: HttpMethod,
  path: string,
  handle: (
    request: Request,
    params: Readonly<Record<string, string>>,
  ) => RouteOutcome | Promise<RouteOutcome>,
): PreparedRoute {
  return {
    method,
    path,
    handle: async (incoming, params) => {
      // 用例的 handler 按标准 Request 写（它们扮演的就是用户 handler），所以这里物化一次。
      // 真实路由只在有人读 context.request 时才付这笔钱，harness 无条件付是它自己的选择。
      const outcome = await handle(incoming.standard(), params);
      return outcome instanceof Response ? absorbResponse(outcome, new ResponseHeaders()) : outcome;
    },
    meta: () => undefined,
  };
}

// JSON body 用例走真实的槽位执行链而不是在 handler 里手搓解析：要证的正是"引擎交出来的
// 标准 Request 能被 reforce 的严格读体(层①)正常消费"。表单/上传自 RFC 0012 S2(#274)起
// 不再由框架解析(Body 槽只认 JSON)，对应用例改走标准 request.formData()——引擎契约没变：
// fastify 那条路径会把 req.body 的 Buffer 重建成标准 Request，boundary 保不住的话立刻炸。
const passthroughBodySchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-conformance",
    validate: (value: unknown) => ({ value }),
  },
};

// 全局别名 FormDataEntryValue 只在 DOM lib 里，本包不引 DOM；从 getAll 的返回类型取同一个联合
type FormValue = ReturnType<FormData["getAll"]>[number];

// FormData → 普通对象：同名多值收成数组，单值不包数组；File 原样保留。用 Object.fromEntries
// 而不是逐 key 赋值：后者遇到名为 `__proto__` 的表单字段会命中原型 setter 静默丢值。
function formDataToRecord(form: FormData): Record<string, FormValue | FormValue[]> {
  return Object.fromEntries(
    [...new Set(form.keys())].map((name) => {
      const values = form.getAll(name);
      const [only] = values;
      return [name, values.length === 1 && only !== undefined ? only : values] as const;
    }),
  );
}

async function requestBody(request: Request, params: Readonly<Record<string, string>>) {
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType === "multipart/form-data" || mediaType === "application/x-www-form-urlencoded") {
    return formDataToRecord(await request.formData());
  }
  const context = new RequestContextState({
    incoming: fromStandardRequest(request),
    method: "POST",
    path: "/echo-body",
    params,
    meta: {},
  });
  const [body] = await createSlotExecutor([{ slot: "body", schema: passthroughBodySchema }])(
    context,
  );
  return body;
}

// File 不能直接 JSON 序列化，压成可断言的摘要
async function describeBody(body: unknown): Promise<unknown> {
  if (!(typeof body === "object" && body !== null)) {
    return body;
  }
  const entries = await Promise.all(
    Object.entries(body).map(async ([key, value]) => {
      if (value instanceof File) {
        return [key, { file: value.name, text: await value.text() }] as const;
      }
      return [key, value] as const;
    }),
  );
  return Object.fromEntries(entries);
}

// 背压用例的流：pull 是需求驱动的，客户端不读时引擎若正确保持背压，produced 就停在很小的值；
// 引擎若把整条流吸干缓存起来，produced 会一路冲到上限。
function countingStream(state: { produced: number }, limit: number): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
  return new ReadableStream({
    pull(controller) {
      if (state.produced >= limit) {
        controller.close();
        return;
      }
      state.produced += 1;
      controller.enqueue(chunk);
    },
  });
}

// IncomingRequest 的引擎侧义务（#341）。这条路由**绕开**上面的 route() 帮手：那个帮手第一件
// 事就是 incoming.standard()，正好把要测的东西抹掉。框架自己在热路径上只用 method / url() /
// header() 三样（路由日志、请求 id），标准 Request 只在用户读 context.request 时才造——所以
// 这三样在每个引擎上都必须独立成立，不能靠"反正 standard() 是对的"顺带保证。
const incomingProbe: PreparedRoute = {
  method: "GET",
  path: "/incoming",
  handle: (incoming) => {
    const url = incoming.url();
    const first = incoming.standard();
    const second = incoming.standard();
    const body = JSON.stringify({
      method: incoming.method,
      pathname: url.pathname,
      query: url.searchParams.get("q"),
      lower: incoming.header("x-probe"),
      mixedCase: incoming.header("X-Probe"),
      absent: incoming.header("x-not-sent"),
      multi: incoming.header("x-multi"),
      // 缓存是硬约束而不是优化：两次读 context.request 若拿到两个 Request，body 会被重复消费。
      cached: first === second,
    });
    const headers = new ResponseHeaders();
    headers.set("content-type", "application/json");
    return Promise.resolve(respond(headers, 200, body));
  },
  meta: () => undefined,
};

interface ConformanceFixtures {
  readonly application: WebApplication;
  readonly flood: { produced: number };
  readonly gate: { release: () => void };
  // "/trickle 的 handler 已被调用"的确定性屏障。排空用例必须在请求真的到达 handler 之后才
  // 调 close，否则 close 会因为还没有在途请求而立刻 resolve——用 sleep 猜这个时刻在并发跑
  // 测试文件时会翻车（同 #177 / #225 的处理方式：把竞态移出测试路径，不要靠等）。
  readonly handlerReached: Promise<void>;
}

function fixtures(): ConformanceFixtures {
  const flood = { produced: 0 };
  let reachHandler = (): void => undefined;
  const handlerReached = new Promise<void>((resolve) => {
    reachHandler = resolve;
  });
  let releaseGate = (): void => undefined;
  const gate = {
    release: () => {
      releaseGate();
    },
  };
  const gateReached = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  const application: WebApplication = {
    routes: [
      route("GET", "/health", () => Promise.resolve(new Response("ok"))),
      // 顺序不能随手写：这里必须复刻编译器的发射顺序（web-routes.ts 按 compareUtf16CodeUnits
      // 排序，`:` 是 0x3A、小写字母从 0x61 起，所以参数路由**先于**同前缀的静态路由）。
      // 把静态段写在前面的话，按注册顺序匹配的引擎（hono）会假绿——实测：顺序反过来时，
      // 去掉 hono 的特异度重排，套件依旧 18/18 全过。
      route("GET", "/users/:id", (_request, params) =>
        Promise.resolve(Response.json({ id: params.id })),
      ),
      route("GET", "/users/self", () => Promise.resolve(new Response("self"))),
      route("POST", "/echo-body", async (request, params) =>
        Response.json(await describeBody(await requestBody(request, params))),
      ),
      route("GET", "/cookies", () => {
        const headers = new Headers();
        headers.append("set-cookie", "a=1; Path=/");
        headers.append("set-cookie", "b=2; Path=/");
        return Promise.resolve(new Response("cookies", { headers }));
      }),
      route("GET", "/echo-headers", (request) =>
        Promise.resolve(Response.json({ multi: request.headers.get("x-multi") })),
      ),
      // 缓冲路径必须用 `respond()` 造，不能用 `new Response(bytes, ...)`（#340）：后者是逃生口，
      // undici 会把字节包成 ReadableStream，body 形态因此是「流」，这条用例就会静默改去覆盖
      // 流式分支——引擎的原生直写分支反而一条用例都没有了。判据是 body 的形态，构造方式必须
      // 与被测的分支对齐。
      route("GET", "/buffered", () => {
        const headers = new ResponseHeaders();
        headers.set("content-type", "text/plain; charset=utf-8");
        return Promise.resolve(respond(headers, 200, new TextEncoder().encode("buffered")));
      }),
      // 首块立刻可读、其余卡在 gate 上：缓冲式引擎会让客户端等到 gate 释放才收到任何字节
      route("GET", "/trickle", () => {
        reachHandler();
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("first"));
              },
              async pull(controller) {
                await gateReached;
                controller.enqueue(new TextEncoder().encode("rest"));
                controller.close();
              },
            }),
          ),
        );
      }),
      route("GET", "/flood", () => Promise.resolve(new Response(countingStream(flood, 10_000)))),
      // 引擎不得改写框架给的 content-type（#373）。这条盯的是一个真实踩过的坑：fastify 对
      // **字符串** payload 会自作主张补 `; charset=utf-8`（对 Buffer 不补），于是 body 形态一换，
      // 同一份核心代码在三个引擎上出站的 content-type 就走散了。charset 必须**不写**——写了
      // 就正好绕开 fastify 的判据，这条用例也就白写了。
      route("GET", "/verbatim-content-type", () => {
        const headers = new ResponseHeaders();
        headers.set("content-type", "application/json");
        return Promise.resolve(respond(headers, 200, '{"ok":true}'));
      }),
      incomingProbe,
    ],
  };
  return { application, flood, gate, handlerReached };
}

// probeIncoming 收的要么是 base（自动补 /incoming），要么是已经拼好 query 的完整 URL。
async function probeIncoming(target: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const url = target.includes("/incoming") ? target : `${target}/incoming`;
  const value: unknown = await (await fetch(url, init)).json();
  if (typeof value !== "object" || value === null) {
    fail("the /incoming probe must answer a JSON object");
  }
  return { ...value };
}

export function adapterConformanceCases(
  options: AdapterConformanceOptions,
): readonly AdapterConformanceCase[] {
  async function withServer(
    run: (base: string, context: ConformanceFixtures) => Promise<void>,
  ): Promise<void> {
    const context = fixtures();
    const server = await options.start(context.application);
    try {
      await run(server.baseUrl, context);
    } finally {
      context.gate.release();
      await server.close();
    }
  }

  function conformanceCase(name: string, run: () => Promise<void>): AdapterConformanceCase {
    return { name: `${options.name}: ${name}`, run };
  }

  return [
    conformanceCase("an unmatched path yields 404 without an Allow header", () =>
      withServer(async (base) => {
        const response = await fetch(`${base}/nowhere`);

        assertEqual(response.status, 404, "status");
        assertEqual(response.headers.get("allow"), null, "allow header");
      }),
    ),

    // 方法不符也是 404：RFC 9110 §9.1 对 405 是 SHOULD 不是 MUST，三大框架默认均无 405
    conformanceCase("a known path under an unregistered method yields 404 without Allow", () =>
      withServer(async (base) => {
        const response = await fetch(`${base}/health`, { method: "DELETE" });

        assertEqual(response.status, 404, "status");
        assertEqual(response.headers.get("allow"), null, "allow header");
      }),
    ),

    conformanceCase("`/p`, `/p/` and `//p` all reach the same route", () =>
      withServer(async (base) => {
        for (const path of ["/health", "/health/", "//health"]) {
          const response = await fetch(`${base}${path}`);

          assertEqual(response.status, 200, `status for ${path}`);
          assertEqual(await response.text(), "ok", `body for ${path}`);
        }
      }),
    ),

    // 坏转义必须按未命中处理，且解码异常不得逃逸出请求循环——逃逸的后果是响应永不写出，
    // 客户端只能挂到超时（#211）。超时护栏就是这条断言的意义所在。
    conformanceCase("a malformed percent-escape is a miss and does not hang", () =>
      withServer(async (base) => {
        for (const path of ["/users/%ZZ", "/users/%E0%A4%A"]) {
          const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });

          assertEqual(response.status, 404, `status for ${path}`);
        }
      }),
    ),

    conformanceCase("a static segment wins over an overlapping parameter segment", () =>
      withServer(async (base) => {
        assertEqual(await (await fetch(`${base}/users/self`)).text(), "self", "static route body");
        assertEqual(
          await (await fetch(`${base}/users/42`)).json(),
          { id: "42" },
          "parameterized route body",
        );
      }),
    ),

    // params 的解码语义决定 codec 收到什么输入（string→bigint 那类转换的正确性依赖它）：
    // decodeURI 语义下 %2F 在路径层保留，%20 正常解。
    conformanceCase("path params decode with %2F preserved and %20 decoded", () =>
      withServer(async (base) => {
        assertEqual(
          await (await fetch(`${base}/users/a%2Fb`)).json(),
          { id: "a/b" },
          "%2F in a param",
        );
        assertEqual(
          await (await fetch(`${base}/users/a%20b`)).json(),
          { id: "a b" },
          "%20 in a param",
        );
      }),
    ),

    conformanceCase("multiple set-cookie headers go out one per line", () =>
      withServer(async (base) => {
        const response = await fetch(`${base}/cookies`);

        assertEqual(
          response.headers.getSetCookie(),
          ["a=1; Path=/", "b=2; Path=/"],
          "set-cookie values",
        );
      }),
    ),

    // 同名请求头不得被引擎并成逗号串之外的形态；标准 Headers 的读取形态就是逗号串，
    // 这里钉的是"两个值都到得了 handler"。
    conformanceCase("repeated request headers all reach the handler", () =>
      withServer(async (base) => {
        const headers = new Headers();
        headers.append("x-multi", "one");
        headers.append("x-multi", "two");

        const response = await fetch(`${base}/echo-headers`, { headers });

        assertEqual(await response.json(), { multi: "one, two" }, "x-multi");
      }),
    ),

    conformanceCase("the engine delivers the content-type it was given, verbatim", () =>
      withServer(async (base) => {
        const response = await fetch(`${base}/verbatim-content-type`);
        await response.text();

        assertEqual(response.headers.get("content-type"), "application/json", "content-type");
      }),
    ),

    // —— IncomingRequest（#341）——

    conformanceCase("the incoming request answers a header by name, case-insensitively", () =>
      withServer(async (base) => {
        const probe = await probeIncoming(base, { headers: { "X-Probe": "seen" } });

        assertEqual(probe.lower, "seen", "lookup by the lowercase name");
        assertEqual(probe.mixedCase, "seen", "lookup by a mixed-case name");
        assertEqual(probe.absent, null, "a header that was not sent");
      }),
    ),

    // 与 /echo-headers 同一份语义，区别是这里不经过标准 Headers：引擎必须自己把同名多值
    // 并成逗号串，否则换引擎就换了 handler 看到的值。
    conformanceCase("the incoming request joins repeated headers with a comma", () =>
      withServer(async (base) => {
        const headers = new Headers();
        headers.append("x-multi", "one");
        headers.append("x-multi", "two");

        const probe = await probeIncoming(base, { headers });

        assertEqual(probe.multi, "one, two", "x-multi");
      }),
    ),

    conformanceCase("the incoming request exposes the parsed request target", () =>
      withServer(async (base) => {
        const probe = await probeIncoming(`${base}/incoming?q=42`);

        assertEqual(probe.method, "GET", "method");
        assertEqual(probe.pathname, "/incoming", "pathname");
        assertEqual(probe.query, "42", "query parameter");
      }),
    ),

    // 缓存不是优化：两次读 context.request 若拿到两个 Request，body 会被重复消费。
    conformanceCase("the incoming request caches the standard Request it materializes", () =>
      withServer(async (base) => {
        const probe = await probeIncoming(base);

        assertEqual(probe.cached, true, "standard() identity across two reads");
      }),
    ),

    // 引擎不得把请求体提前消费到不可用。JSON 走真实槽位读体，表单走标准 formData()——
    // fastify 那条路径要把 Buffer 重建成标准 Request，boundary 丢了这里立刻炸。
    conformanceCase("a json body reaches the body slot through the strict reader", () =>
      withServer(async (base) => {
        const response = await fetch(`${base}/echo-body`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "amy" }),
        });

        assertEqual(await response.json(), { name: "amy" }, "json body");
      }),
    ),

    conformanceCase("an urlencoded body reaches the handler through request.formData()", () =>
      withServer(async (base) => {
        const response = await fetch(`${base}/echo-body`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "name=amy&tag=a&tag=b",
        });

        assertEqual(await response.json(), { name: "amy", tag: ["a", "b"] }, "urlencoded body");
      }),
    ),

    conformanceCase("a multipart body reaches the handler with its file intact", () =>
      withServer(async (base) => {
        const form = new FormData();
        form.append("name", "amy");
        form.append("avatar", new File(["12345"], "a.bin"));

        const response = await fetch(`${base}/echo-body`, { method: "POST", body: form });

        assertEqual(
          await response.json(),
          { name: "amy", avatar: { file: "a.bin", text: "12345" } },
          "multipart body",
        );
      }),
    ),

    conformanceCase("a response carrying content-length is delivered whole", () =>
      withServer(async (base) => {
        const response = await fetch(`${base}/buffered`);

        assertEqual(await response.text(), "buffered", "body");
      }),
    ),

    // 不带 content-length = 流式：首块必须在服务端还没写完时就能被读到。缓冲式引擎会让
    // 客户端一直等到整条流结束。
    conformanceCase("a response without content-length streams the first chunk early", () =>
      withServer(async (base, context) => {
        // 超时信号是这条用例的失败模式护栏：整体缓冲的引擎会一直等到 gate 释放才吐字节，
        // 没有它就是挂起而不是失败——挂起的用例读起来像"卡了"，不像"违约了"。超时可能落在
        // fetch 上（响应头都没来）也可能落在 read 上，两处统一换成同一句失败信息。
        let first: Uint8Array | undefined;
        let cancel: () => Promise<void> = () => Promise.resolve();
        try {
          const response = await fetch(`${base}/trickle`, { signal: AbortSignal.timeout(3_000) });
          const reader = response.body?.getReader() ?? fail("trickle response has no body");
          cancel = () => reader.cancel();
          first = (await reader.read()).value;
        } catch (cause) {
          fail(`expected the first chunk before the response finished, got ${String(cause)}`);
        }
        assertEqual(new TextDecoder().decode(first), "first", "first chunk");

        context.gate.release();
        await cancel();
      }),
    ),

    // 背压：客户端不读时引擎不得把整条流吸干缓存起来。上限取得很松（10000 块里 500 块 =
    // 32MB），只用于区分"有背压"与"整体缓冲"，不用于卡具体水位。
    conformanceCase("a streaming response keeps backpressure while the client is idle", () =>
      withServer(async (base, context) => {
        const response = await fetch(`${base}/flood`);
        const reader = response.body?.getReader() ?? fail("flood response has no body");

        await reader.read();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const produced = context.flood.produced;
        await reader.cancel();

        assert(
          produced < 500,
          `expected backpressure to bound production, but ${produced} chunks were produced`,
        );
      }),
    ),

    // 客户端中途断开：写出期故障不得逃逸成 unhandled rejection（Node 默认行为是进程退出，
    // 任何客户端都能远程打崩服务），服务必须继续可用。
    conformanceCase("a client disconnecting mid-response leaves the server serving", () =>
      withServer(async (base, context) => {
        const escaped: unknown[] = [];
        const capture = (reason: unknown): void => {
          escaped.push(reason);
        };
        process.on("unhandledRejection", capture);
        try {
          const controller = new AbortController();
          const response = await fetch(`${base}/flood`, { signal: controller.signal });
          await response.body?.getReader().read();
          controller.abort();
          context.gate.release();
          await new Promise((resolve) => setTimeout(resolve, 200));

          assertEqual(await (await fetch(`${base}/health`)).text(), "ok", "server still serving");
          assertEqual(escaped.length, 0, `unhandled rejections: ${escaped.map(String).join("; ")}`);
        } finally {
          process.off("unhandledRejection", capture);
        }
      }),
    ),

    conformanceCase("close drains the in-flight request before resolving", async () => {
      const context = fixtures();
      const server = await options.start(context.application);

      const inflight = fetch(`${server.baseUrl}/trickle`).then((response) => response.text());
      // 确定性屏障：等 handler 真的被调用，而不是猜一个时长
      await context.handlerReached;
      let closed = false;
      const closing = server.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert(!closed, "close resolved while a request was still in flight");

      context.gate.release();
      await closing;
      assertEqual(await inflight, "firstrest", "in-flight response body");
    }),

    conformanceCase("close is idempotent", async () => {
      const context = fixtures();
      const server = await options.start(context.application);

      await server.close();
      await server.close();
      await server.close();
    }),

    // HMR 形态（见 @reforce/runtime 的 hmr-manager）：start → close → start 反复循环，
    // 引擎实例不可复用时必须在 start 里重建，否则第二轮就抛。
    conformanceCase("start after close works across repeated rounds", async () => {
      for (let round = 0; round < 3; round += 1) {
        const context = fixtures();
        const server = await options.start(context.application);
        try {
          assertEqual(
            await (await fetch(`${server.baseUrl}/health`)).text(),
            "ok",
            `round ${round} body`,
          );
        } finally {
          await server.close();
        }
      }
    }),
  ];
}
