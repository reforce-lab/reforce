# @reforce/web-hono

Hono 引擎适配器。reforce 的路由处理函数就是一个普通的 hono handler，不绕过 hono 的任何通道：

```
hono 生态中间件（cors / helmet / compress / rate-limit / static）
 └─ hono 路由匹配（未命中 → hono 自己的 404，reforce 不接管）
     └─ reforce handler ── 直接 return 标准 Response
         └─ runInRequestScope → reforce 洋葱链 → 校验 → handler → 序列化
```

reforce 只提供两座桥，其余一律交给 hono 生态。

## 两座桥

### 应用级 configurer —— 注册任何路由之前调用一次

```ts
import { Injectable } from "@reforce/core";
import { type HonoConfigure, type HonoConfigurer } from "@reforce/web-hono";
import { cors } from "hono/cors";

@Injectable()
export class Cors implements HonoConfigurer {
  configure: HonoConfigure = (app) => {
    app.use("*", cors());
  };
}
```

写成**类字段 + 箭头函数**（而不是方法）不是风格问题：TS 只在这个位置做上下文类型化，方法形态的 `implements` 下 `app` 会塌成 `any`，连带你在 `app.use()` 里写的中间件回调参数一起失去类型。`implements` 与字段形态可以同时成立——集合成员资格靠 `implements`，零标注靠字段。

写 0 个、1 个、N 个都合法。

> **时序是硬约束**：`app.use` 只对**之后**注册的路由生效。适配器保证所有 configurer 都跑在路由注册之前，包括 `async` 的。

### 路由级 customizer —— 每条路由注册之前调用一次

reforce 不定义任何 per-route 词汇，直接把注册点交出去。返回的中间件插在 reforce handler 之前：

```ts
export const RateLimit = defineRouteMarker<{ max: number }>("rateLimit");

@Injectable()
export class RouteLimits implements HonoRouteCustomizer {
  customize: HonoRouteCustomize = (route) => {
    const limit = route.meta(RateLimit);
    return limit === undefined ? undefined : [rateLimiter({ limit: limit.max })];
  };
}
```

定位单条路由用 `route.meta(Marker)`（声明式）或直接匹配 `route.path` / `route.method`（一次性场景）。

## 已知约束

### `@Head` 不单独生效

hono 把 `HEAD` 硬编码转成 `GET`，位置在路由匹配之前且没有 hook。绕法实测可行，但依赖未文档化的内部实现、上游一改就碎，而且会让 `c.req.method` 变成私有串，导致按 method 分支的中间件（csrf / cache / 部分限流）在 HEAD 上误判。本包按「不大包大揽」放弃绕法，接受 hono 的默认行为。

后果分两种，**第二种重得多**：

| 形态 | 结果 |
|---|---|
| `@Head("/x")` 与 `@Get("/x")` 并存 | `HEAD /x` 跑 GET 的 handler 并丢掉 body。HTTP 语义正确，但 `@Head` 里写的代码不执行 |
| `@Head("/x")` **没有** GET 兄弟路由 | `HEAD /x` 直接落 hono 的 404，**整条路由不可达** |

第二种在 web-node 下同一份代码返回 200，而编译器不要求 HEAD 路由有 GET 兄弟 —— **编译期零诊断**。声明了 response schema 的 `@Head("/x", schemas)` 因为返回类型被钉死，看起来更像能用，隐蔽性反而更强。

### hono 中间件跑在 reforce 请求作用域之外

`runInRequestScope` 开在 `route.handle` 内部，所以 `c.set()` / `c.var` 默认到不了 reforce handler。官方解法是装 `hono/context-storage`：

```ts
import { contextStorage, getContext } from "hono/context-storage";

app.use(contextStorage());
```

装上之后在 handler 乃至更深的 DI bean 里 `getContext().get("tenant")` 都能拿到。**reforce 不提供自己的桥接 API** —— 用 hono 自己的方案。

### 钉死 TrieRouter，放弃 hono 的性能招牌

`RegExpRouter` 遇到 `/users/:id` + `/users/self` 直接抛 `UnsupportedPathError`；`SmartRouter` 会在**第一个请求**时才静默回退，启动期看不出来。本包固定用 `TrieRouter`，换来启动即确定的行为。

### 路由注册顺序被重排

hono 按注册顺序匹配、没有静态段优先的概念，而 reforce 编译器按 UTF-16 码元排序发射（`:` 是 0x3A，小写字母从 0x61 起），所以 `/users/:id` **必然**排在 `/users/self`、`/users/me` 之前。适配器在注册前按逐段特异度重排（静态段胜过参数段，取最左侧的差异），段数不同、不可能撞车的路由保持发射顺序。

### `hono/cache` 不可用

依赖 Web Cache API，Node 26 没有 `caches`。与 reforce 无关。

## 配置

```ts
export interface WebHonoServeSettings {
  readonly port: number;      // 0 = 让操作系统分配临时端口（实际端口见 stderr 的启动日志）
  readonly hostname?: string; // 缺省 localhost，只有本机连得上；对外配 0.0.0.0 或 ::
}
```

按 ADR 0005 的先例，应用用 `class ... extends ConfigProperties("...", schema) implements WebHonoServeSettings` 闭合这条开放契约边。
