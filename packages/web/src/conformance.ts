import type { PreparedRoute, WebApplication } from "@/adapter";
import { createRequestInputValidator } from "@/execution/input-validation";
import { RequestContextState } from "@/execution/request-context";
import type { HttpMethod } from "@/routing/vocabulary";

// 引擎适配器一致性套件（#234）：WebEngineAdapter 的行为契约（见 adapter.ts）在每个引擎上都必须成立。
// 每条断言都对应一个在真实引擎上实测到的差异或缺陷，不是凭空罗列的清单——引擎之间"看起来
// 都能跑"，差别全在这些边角上。
//
// 不 import vitest：那样 dist 里就带上 vitest 的 import，@reforce/web 得把它从 devDependency
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

function route(method: HttpMethod, path: string, handle: PreparedRoute["handle"]): PreparedRoute {
  return { method, path, handle, meta: () => undefined };
}

// body 用例走真实的校验管线而不是在 handler 里手搓解析：要证的正是"引擎交出来的标准 Request
// 能被 reforce 的 body 分派正常消费"。fastify 那条路径会把 req.body 的 Buffer 重建成标准
// Request，boundary 保不住的话这里立刻炸。
const passthroughBodySchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-conformance",
    validate: (value: unknown) => ({ value }),
  },
};

async function validatedBody(request: Request, params: Readonly<Record<string, string>>) {
  const context = new RequestContextState({
    request,
    url: new URL(request.url),
    method: "POST",
    path: "/echo-body",
    params,
    meta: {},
  });
  await createRequestInputValidator({ body: passthroughBodySchema })(context);
  return context.body;
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

interface ConformanceFixtures {
  readonly application: WebApplication;
  readonly flood: { produced: number };
  readonly gate: { release: () => void };
}

function fixtures(): ConformanceFixtures {
  const flood = { produced: 0 };
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
      // 静态段必须赢过参数段：hono 上这是静默错路由（按注册顺序匹配，无特异度概念）
      route("GET", "/users/self", () => Promise.resolve(new Response("self"))),
      route("GET", "/users/:id", (_request, params) =>
        Promise.resolve(Response.json({ id: params.id })),
      ),
      route("POST", "/echo-body", async (request, params) =>
        Response.json(await describeBody(await validatedBody(request, params))),
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
      route("GET", "/buffered", () => {
        const bytes = new TextEncoder().encode("buffered");
        return Promise.resolve(
          new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } }),
        );
      }),
      // 首块立刻可读、其余卡在 gate 上：缓冲式引擎会让客户端等到 gate 释放才收到任何字节
      route("GET", "/trickle", () =>
        Promise.resolve(
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
        ),
      ),
      route("GET", "/flood", () => Promise.resolve(new Response(countingStream(flood, 10_000)))),
    ],
  };
  return { application, flood, gate };
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

    // 引擎不得把请求体提前消费到不可用。三种 content-type 都要走通 reforce 的 body 分派——
    // fastify 那条路径要把 Buffer 重建成标准 Request，boundary 丢了这里立刻炸。
    conformanceCase("a json body reaches the validated body slot", () =>
      withServer(async (base) => {
        const response = await fetch(`${base}/echo-body`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "amy" }),
        });

        assertEqual(await response.json(), { name: "amy" }, "json body");
      }),
    ),

    conformanceCase("an urlencoded body reaches the validated body slot", () =>
      withServer(async (base) => {
        const response = await fetch(`${base}/echo-body`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "name=amy&tag=a&tag=b",
        });

        assertEqual(await response.json(), { name: "amy", tag: ["a", "b"] }, "urlencoded body");
      }),
    ),

    conformanceCase("a multipart body reaches the validated body slot with its file", () =>
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
      // 请求已到达 handler（接受连接是异步的）
      await new Promise((resolve) => setTimeout(resolve, 100));
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
