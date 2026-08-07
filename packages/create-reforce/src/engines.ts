// 三个 web 引擎在生成物里的全部差异（#240）。模板按 templates/engine-<key>/ 叠加，
// 差异只落在两个文件上：src/application.ts 的 starter import、src/config/web-server.config.ts
// 的 implements Web*ServeSettings。引擎的第三方依赖（hono / @hono/node-server / fastify）
// 是 @reforce/web-<key> 自己的 dependencies，模板不重复声明——生成的应用代码不直接
// import 它们。
export const ENGINE_KEYS = ["hono", "fastify", "node"] as const;

export type EngineKey = (typeof ENGINE_KEYS)[number];

export interface EngineDefinition {
  readonly key: EngineKey;
  readonly packageName: string;
  readonly label: string;
  readonly hint: string;
}

export const ENGINES: Readonly<Record<EngineKey, EngineDefinition>> = {
  hono: {
    key: "hono",
    packageName: "@reforce/web-hono",
    label: "Hono",
    hint: "Web 标准 Request/Response，社区生态最广",
  },
  fastify: {
    key: "fastify",
    packageName: "@reforce/web-fastify",
    label: "Fastify",
    hint: "成熟的 Node.js 服务端生态与插件体系",
  },
  node: {
    key: "node",
    packageName: "@reforce/web-node",
    label: "Node",
    hint: "直接架在 node:http 上，除路由匹配外无第三方依赖",
  },
};

export const DEFAULT_ENGINE: EngineKey = "hono";

export function isEngineKey(value: string): value is EngineKey {
  return (ENGINE_KEYS as readonly string[]).includes(value);
}
