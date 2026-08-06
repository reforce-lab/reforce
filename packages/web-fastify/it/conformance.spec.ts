import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { adapterConformanceCases } from "@reforce/web/conformance";
import type { FastifyInstance } from "fastify";
import { describe, test } from "vitest";
import { WebEngine } from "@/index";

// 引擎适配器一致性套件在 fastify 上的接入（#234，套件本体在 @reforce/web/conformance）。
// 与 web-node / web-hono 跑的是同一份断言。

describe("WebEngine adapter conformance", () => {
  for (const item of adapterConformanceCases({
    name: "fastify",
    async start(application) {
      const engine = new WebEngine({ port: 0 }, [], []);
      const handle = await engine.start(application);
      const app = Reflect.get(engine, "app") as FastifyInstance;
      const address = (app.server as Server).address() as AddressInfo;
      return {
        baseUrl: `http://localhost:${address.port}`,
        close: () => handle.close(),
      };
    },
  })) {
    test(item.name, () => item.run(), 30_000);
  }
});
