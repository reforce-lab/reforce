# @reforce/web-fastify

Fastify 引擎适配器。reforce 的路由处理函数就是一个普通的 fastify handler，走 fastify 正常的响应通道：

```
fastify 插件与钩子（cors / helmet / compress / rate-limit / static）
 └─ fastify 路由匹配（未命中 → fastify 自己的 404，reforce 不接管）
     └─ reforce handler ── reply.code / reply.header / reply.send
         └─ runInRequestScope → reforce 洋葱链 → 校验 → handler → 序列化
```

reforce 只提供两座桥，其余一律交给 fastify 生态。

## 两座桥

### 应用级 configurer —— 注册任何路由之前调用一次

```ts
@Injectable()
export class Security implements FastifyConfigurer {
  configure: FastifyConfigure = async (app) => {
    await app.register(helmet);
    await app.register(compress);
  };
}
```

写成**类字段 + 箭头函数**（而不是方法）不是风格问题：TS 只在这个位置做上下文类型化，方法形态的 `implements` 下 `app` 会塌成 `any`。`implements` 与字段形态可以同时成立。

写 0 个、1 个、N 个都合法。

> 构造期选项到不了 configurer —— `routerOptions` 在实例构造时读走，`initialConfig` 是冻结的（实测改写抛 `TypeError`）。那些走 `WebFastifyServeSettings`。

### 路由级 customizer —— 每条路由注册之前调用一次

返回值原样合并进 `app.route()`，因此用户能用**任何** fastify 的 per-route 生态能力（`config` / `preHandler` / `constraints` / `bodyLimit`…）：

```ts
export const RateLimit = defineRouteMarker<{ max: number }>("rateLimit");

@Injectable()
export class RouteLimits implements FastifyRouteCustomizer {
  customize: FastifyRouteCustomize = (route) => {
    const limit = route.meta(RateLimit);
    return limit && { config: { rateLimit: { max: limit.max } } };   // fastify 原生写法
  };
}
```

或直接匹配，适合一次性场景：

```ts
customize: FastifyRouteCustomize = (route) =>
  route.path.startsWith("/admin") ? { onRequest: [requireVpn] } : undefined;
```

**合并规则是硬错，不是静默丢弃**（静默丢弃会让人以为定制生效了）：

| 不得覆盖 | 为什么 |
|---|---|
| `method` / `url` / `handler` | reforce 的注册面，被改写就是静默错路由 |
| `schema.response` | fast-json-stringify 会插进序列化路径，与 reforce 的 schema 白名单投影双重裁剪，结果不可预测 |

想要 fastify 原生 swagger 的用户自己手写 JSON Schema 挂到别处 —— reforce 因此也不暴露 `PreparedRoute.schemas`。`schema` 的其它槽位（`hide` 等）不受限制。

## 自装 buffer content-type parser

本包关掉了 fastify 的全部默认解析，换成一个把字节原样交出的 parser，再用它重建标准 `Request`。

放任默认解析的代价是把一整类 4xx 挪出 reforce 洋葱（实测）：畸形 JSON → `FST_ERR_CTP_INVALID_JSON_BODY`、空 body → `FST_ERR_CTP_EMPTY_JSON_BODY`、未知 content-type → 415。三者都**不经** observability 中间件、**不经** reforce 的错误处理器。改用 buffer parser 后全部进 reforce，`bodyLimit` 仍然生效（超限照旧 413）。

重建时 body 传的是 `Buffer`（BufferSource）：undici 对它既不推导也不覆写 `content-type`，原始头因此原样存活 —— multipart 的 boundary 保得住，标准 `Request.formData()` 才解得开。

副作用：**`@fastify/formbody` 与 `@fastify/multipart` 变成冗余而非不可用** —— 标准 `Request.formData()` 原生覆盖两者。

## 已知约束

### `exposeHeadRoutes` 被关掉

两个理由：

1. 开着的话 fastify 会给每条 GET 自动补一条 HEAD，而 reforce 允许同一路径上同时写 `@Get` 与 `@Head` —— 两者相撞，启动期直接 `FST_ERR_DUPLICATED_ROUTE`。一份合法的 reforce 应用因此在 fastify 上起不来。
2. 关掉之后的语义与 web-node 逐条对齐：GET-only 路径上的 `HEAD` → 404，显式 `@Head` 路由 → 200。开着反而让 fastify 与其它引擎不一致。

想要「GET 自动带 HEAD」的用户在 configurer 里自行开启。

> 与 hono 的对比：hono 把 HEAD 硬编码转成 GET，`@Head` 的 handler 会被影子掉、没有 GET 兄弟时整条路由不可达。fastify 这边 `@Head` 是正常工作的。

### 插件装饰器不可见

`req.cookies` / `req.user` 这类由插件挂在 fastify 请求对象上的东西，在 reforce handler 里拿不到 —— reforce 拿到的是重建出来的标准 `Request`。**reforce 不提供桥接** —— 需要的话在 route customizer 的 `preHandler` 里自行处理，或用 fastify 自己的方案。

### `onBadUrl` 是 raw 通道

签名是 `(path, IncomingMessage, ServerResponse)`，没有 `Reply`，所以坏转义的响应是手写 `writeHead`，绕过所有钩子。更阴的是它**只对已注册过路由的方法触发**：`GET /users/%ZZ` 走 `onBadUrl`，而 `POST /users/%ZZ`（无 POST 路由）落 `notFoundHandler`。两条路径都是 404，各有测试钉住。

### 404 归 fastify

reforce 不调 `setNotFoundHandler`，想定制就在 configurer 里自己设。

### `maxParamLength` 超限是 414，不是 404

同一个超长参数请求，web-node 回 404、fastify 回 `414 URI Too Long`。两边都是「请求被拒」，414 反而更贴切，而这个设置本身是 opt-in 的，因此不为了对齐去拦截改写。这条不在 `WebEngineAdapter` 契约里，也不进一致性套件。

## 配置

```ts
export interface WebFastifyServeSettings {
  readonly port: number;            // 0 = 让操作系统分配临时端口（实际端口见 stderr 的启动日志）
  readonly hostname?: string;
  readonly maxParamLength?: number; // 缺省不限制，与 web-node 对齐（fastify 自己的默认是 100）
  readonly bodyLimit?: number;      // 缺省用 fastify 的默认值（1 MiB）
}
```

`maxParamLength` / `bodyLimit` 之所以放在 settings 而不是 configurer：它们是 fastify 的构造期选项，configurer 跑的时候实例已经造好了。

按 ADR 0005 的先例，应用用 `class ... extends ConfigProperties("...", schema) implements WebFastifyServeSettings` 闭合这条开放契约边。
