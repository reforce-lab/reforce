import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { RouteResponse } from "@reforce/web-core";
import type { WebApplication } from "@reforce/web-core/adapter";
import { adapterConformanceCases } from "@reforce/web-core/conformance";
import { describe, expect, test } from "vitest";

// 套件自身的负向验证（#234）：一致性套件如果对着任何实现都绿，它就没有价值。这里起一个"坏适配器"
// ——刻意违反契约的每一条——再断言套件确实在对应的用例上失败。
//
// 坏在哪：路径不归一（原样 pathname 精确匹配）、方法不符发 405 + Allow、坏转义直接
// decodeURIComponent 让 URIError 逃逸、响应整体缓冲后一次性写出（无背压、首块不早发）。

// 精确匹配 + 单段参数，故意不做任何归一。坏转义在 decodeURIComponent 处抛 URIError，无人接住。
function matchSegments(
  pattern: readonly string[],
  actual: readonly string[],
): Record<string, string> | undefined {
  if (pattern.length !== actual.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (const [index, segment] of pattern.entries()) {
    const value = actual[index] ?? "";
    if (segment.startsWith(":")) {
      params[segment.slice(1)] = decodeURIComponent(value);
      continue;
    }
    if (segment !== value) {
      return undefined;
    }
  }
  return params;
}

function findRoute(application: WebApplication, method: string, pathname: string) {
  for (const item of application.routes) {
    if (item.method !== method) {
      continue;
    }
    const params = matchSegments(item.path.split("/"), pathname.split("/"));
    if (params !== undefined) {
      return { route: item, params };
    }
  }
  return undefined;
}

function toRequest(request: IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [name, values] of Object.entries(request.headersDistinct)) {
    for (const value of values ?? []) {
      headers.append(name, value);
    }
  }
  const method = request.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request) as ReadableStream;
    init.duplex = "half";
  }
  return new Request(url, init);
}

// 整体缓冲后一次性写出：无背压，流式响应的首块也不会提前到达；set-cookie 并成单值。
// 这是**故意写坏的**适配器，用来证明 conformance 套件抓得住这两种违规——所以它这里
// 无条件把流读干，正是契约禁止的做法。
async function writeBuffered(response: ServerResponse, result: RouteResponse): Promise<void> {
  const body = await drainBody(result.body);
  const out: Record<string, string> = {};
  result.headers.forEach((value, name) => {
    out[name] = value;
  });
  response.writeHead(result.status, out);
  response.end(body);
}

async function drainBody(body: RouteResponse["body"]): Promise<Buffer | undefined> {
  if (body === null) {
    return undefined;
  }
  if (typeof body === "string") {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function badAdapterServer(application: WebApplication): Server {
  const registeredPaths = new Set(application.routes.map((item) => item.path));

  function methodMismatch(response: ServerResponse, pathname: string): boolean {
    if (!registeredPaths.has(pathname)) {
      return false;
    }
    const allowed = application.routes
      .filter((item) => item.path === pathname)
      .map((item) => item.method);
    response.writeHead(405, { allow: allowed.join(", ") });
    response.end();
    return true;
  }

  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const found = findRoute(application, request.method ?? "GET", url.pathname);
      if (found === undefined) {
        if (!methodMismatch(response, url.pathname)) {
          response.writeHead(404);
          response.end();
        }
        return;
      }
      await writeBuffered(
        response,
        await found.route.handle(toRequest(request, url), found.params),
      );
    })();
  });
}

async function runCase(name: string): Promise<string | undefined> {
  const item = adapterConformanceCases({
    name: "bad",
    async start(application) {
      const server = badAdapterServer(application);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address() as AddressInfo;
      return {
        baseUrl: `http://localhost:${address.port}`,
        close: () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      };
    },
  }).find((candidate) => candidate.name === `bad: ${name}`);
  if (item === undefined) {
    throw new Error(`No conformance case named ${name}`);
  }
  try {
    await item.run();
    return undefined;
  } catch (error) {
    return String(error);
  }
}

describe("the conformance suite rejects an adapter that violates the contract", () => {
  test("it catches a missing 405 → 404 conversion", async () => {
    expect(
      await runCase("a known path under an unregistered method yields 404 without Allow"),
    ).toContain("expected 404");
  });

  test("it catches missing path normalization", async () => {
    expect(await runCase("`/p`, `/p/` and `//p` all reach the same route")).toContain("status for");
  });

  test("it catches a set-cookie header collapsed into one value", async () => {
    expect(await runCase("multiple set-cookie headers go out one per line")).toContain(
      "set-cookie values",
    );
  });

  // 缓冲式引擎在这条上会一直等到整条流结束才吐字节；套件里的超时信号把"挂起"变成"失败"
  test("it catches an adapter that withholds the first chunk of a stream", async () => {
    expect(
      await runCase("a response without content-length streams the first chunk early"),
    ).toContain("expected the first chunk");
  }, 20_000);

  test("it catches an adapter that buffers a streaming response whole", async () => {
    expect(
      await runCase("a streaming response keeps backpressure while the client is idle"),
    ).toContain("expected backpressure");
  });
});
