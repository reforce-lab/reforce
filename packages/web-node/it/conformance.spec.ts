import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { adapterConformanceCases } from "@reforce/web/conformance";
import { describe, test } from "vitest";
import { WebEngine } from "@/index";

// 引擎适配器一致性套件在 web-node 上的接入（#234，套件本体在 @reforce/web/conformance）。
// web-node 是基线：它是最小实现与 benchmark 基准，套件在这里跑绿才说明契约本身可满足，
// 后续引擎包接同一套件即可对齐。
//
// 套件不 import vitest（那会把 vitest 从 devDependency 顶成 peer），返回用例数组由这里套壳。

describe("WebEngine adapter conformance", () => {
  for (const item of adapterConformanceCases({
    name: "node",
    async start(application) {
      const engine = new WebEngine({ port: 0 });
      const handle = await engine.start(application);
      // 引擎的公开面只有 close，端口从私有 server 反射读——比解析监听日志稳。
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
