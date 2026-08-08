import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { adapterConformanceCases } from "@reforce/web-core/conformance";
import { describe, test } from "vitest";
import { WebEngine } from "@/index";

// 引擎适配器一致性套件在 hono 上的接入（#234，套件本体在 @reforce/web-core/conformance）。
// 与 web-node 跑的是同一份断言——「换引擎零改动」这句话的依据就在这里。

describe("WebEngine adapter conformance", () => {
  for (const item of adapterConformanceCases({
    name: "hono",
    async start(application) {
      const engine = new WebEngine({ port: 0 }, [], []);
      const handle = await engine.start(application);
      const server = Reflect.get(engine, "server") as Server;
      const address = server.address() as AddressInfo;
      return {
        baseUrl: `http://localhost:${address.port}`,
        close: () => handle.close(),
      };
    },
  })) {
    test(item.name, () => item.run(), 30_000);
  }
});
