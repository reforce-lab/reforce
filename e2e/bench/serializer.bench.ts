// 基准 ②（#153）：响应序列化的 A/B——同一条 PreparedRoute 管线内，唯一变量是序列化方式：
// - schema 白名单：响应 schema 的 jsonSchema 导出驱动启动期预构建的字段投影（多余字段不出线）；
// - 手动 stringify：handler 直接返回 new Response(JSON.stringify(value))（无 schema 路由）。
// 另附裸 JSON.stringify 闭环参照（无 Response、无管线）。注意白名单侧输出比手动侧少一个
// 字段（secret 被剥除），这正是它的功能；差值 = 投影 + 校验通道的代价减去少序列化一个字段。
// 复跑：`cd e2e && bun run bench:serializer`。

import type { ApplicationContext, BeanClass, BeanDefinition } from "@reforce/context";
import { createWebApplication, type PreparedRoute } from "@reforce/web";

const iterations = 200_000;
const rounds = 5;

interface Profile {
  readonly id: string;
  readonly name: string;
  readonly secret: string;
}

const payload: Profile = {
  id: "1234567890123456789",
  name: "user-1234567890123456789",
  secret: "do-not-leak",
};

class ProfileController {
  whitelisted(): Profile {
    return payload;
  }

  manual(): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}

const whitelistSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "reforce-bench",
    validate: (value: unknown) => ({ value }),
    jsonSchema: {
      output: (): Record<string, unknown> => ({
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" } },
      }),
    },
  },
};

// 序列化基准只需要 get 返回 controller 实例；请求作用域直通执行（fixture 不播种）。
const context: ApplicationContext = {
  start: () => Promise.resolve(),
  get: <T extends object>(_target: BeanClass<T> | BeanDefinition<T>): T =>
    // 表内唯一 controller 即 ProfileController // justified: 基准替身的身份映射
    new ProfileController() as unknown as T,
  runInRequestScope: <R>(_seeds: never[], callback: () => R) =>
    Promise.resolve(callback()) as Promise<Awaited<R>>,
  close: () => Promise.resolve(),
};

const application = createWebApplication({
  context,
  table: {
    schemaVersion: 1,
    routes: [
      {
        method: "GET",
        path: "/whitelisted",
        controller: ProfileController,
        beanId: "bench#ProfileController",
        handler: "whitelisted",
        invoke: (instance: ProfileController) => instance.whitelisted(),
        middleware: [],
        meta: {},
        schemas: { response: whitelistSchema },
      },
      {
        method: "GET",
        path: "/manual",
        controller: ProfileController,
        beanId: "bench#ProfileController",
        handler: "manual",
        invoke: (instance: ProfileController) => instance.manual(),
        middleware: [],
        meta: {},
        schemas: {},
      },
    ],
    errorHandlers: [],
  },
});

function routeFor(path: string): PreparedRoute {
  const route = application.routes.find((candidate) => candidate.path === path);
  if (route === undefined) {
    throw new Error(`missing bench route ${path}`);
  }
  return route;
}

const request = new Request("https://bench.local/");

async function measureRoute(route: PreparedRoute): Promise<number> {
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    await route.handle(request, {});
  }
  return iterations / ((performance.now() - started) / 1000);
}

function measureStringify(): number {
  const started = performance.now();
  let sink = 0;
  for (let index = 0; index < iterations; index += 1) {
    sink += JSON.stringify(payload).length;
  }
  if (sink === 0) {
    throw new Error("unreachable");
  }
  return iterations / ((performance.now() - started) / 1000);
}

const whitelisted = routeFor("/whitelisted");
const manual = routeFor("/manual");

let bestWhitelisted = 0;
let bestManual = 0;
let bestStringify = 0;
for (let round = 0; round < rounds; round += 1) {
  bestWhitelisted = Math.max(bestWhitelisted, await measureRoute(whitelisted));
  bestManual = Math.max(bestManual, await measureRoute(manual));
  bestStringify = Math.max(bestStringify, measureStringify());
}

console.log(
  `Bun ${Bun.version} · ${process.platform}-${process.arch} · iterations=${iterations} × rounds=${rounds}（取每轮最好值）`,
);
console.log("");
console.log("| variant | ops/s |");
console.log("| --- | --- |");
console.log(`| PreparedRoute · response schema 白名单投影 | ${bestWhitelisted.toFixed(0)} |`);
console.log(`| PreparedRoute · handler 手动 JSON.stringify | ${bestManual.toFixed(0)} |`);
console.log(`| 裸 JSON.stringify（无管线参照） | ${bestStringify.toFixed(0)} |`);
