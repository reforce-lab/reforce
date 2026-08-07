# Reforce 应用

## 跑起来

```bash
pnpm run dev

curl http://localhost:3000/greetings/world
# {"name":"world","message":"Hello, world!"}
```

| 命令 | 做什么 |
| --- | --- |
| `dev` | 编译并启动，源码变了自动重来 |
| `build` | 产出 `dist/main.mjs` |
| `start` | 运行已经构建好的产物 |
| `typecheck` | 类型检查 |

## 目录

```
src/
  application.ts                        应用入口，声明装上哪些 starter
  config/                               配置，值来自环境变量
    web-server.config.ts                  监听端口
    app.config.ts                         应用自己的配置
  features/                             业务：一个模块一个目录，模块自己的一切都在里面
    greeting/
      greeting.controller.ts              路由：路径、方法、schema
      greeting.service.ts                 业务规则 + 它需要的端口（GreetingStore 接口）
      greeting.dto.ts                     进出的形状：请求校验 + 响应白名单
      greeting.exception.ts               只有这个模块会抛的异常
    health/
      health.controller.ts                健康检查（没有业务规则，就不必造 service）
      health.dto.ts
  infrastructure/                       和外部世界、和框架接壤的适配件
    web/                                  HTTP 这一面
      request-logging.middleware.ts        所有请求都走（observability）
      api-key.middleware.ts                写接口的准入检查（admission）
      http-error.handler.ts                异常 → 状态码的翻译层
      fallback-error.handler.ts            兜底 500，日志留全、响应不泄漏
    persistence/                           存储这一面
      in-memory-greeting.store.ts          换数据库时只改这里
  shared/                               跨模块的公共词汇
    http/
      not-found.exception.ts               通用异常，不带 HTTP 状态码
      unauthorized.exception.ts
    pagination/
      pagination.dto.ts                    请求形状、响应外壳、切片函数
      sort-order.enum.ts                   同一个概念的另一块，所以挨着放
.env.example                            可提交的配置样例，复制成 .env 再改
```

文件名一律 `<名字>.<种类>.ts`（`greeting.controller.ts`、`in-memory-greeting.store.ts`）。
纯约定，框架不认这个后缀——但目录一深，一眼扫过去就知道每个文件是干什么的。

### 东西放哪儿

判据只有一条：**改一个需求要动的文件，在不在同一个目录里。**

按这条推下来是三层：

- **`features/<模块>/`** —— 默认全塞这儿。模块的 controller、service、dto、专属异常都在一起，
  改一个需求不用在几棵目录树之间跳。
- **`infrastructure/`** —— 碰外部世界或框架的适配件，按**外部世界的哪一面**分子目录
  （`web/`、`persistence/`），不按框架装饰器的种类分。中间件和错误处理器都属于 HTTP 这一面，
  所以都在 `web/`。
- **`shared/`** —— 跨模块的公共词汇，按**概念**分子目录。`pagination/` 里 dto 和 enum 挨着，
  因为它们是同一个概念的两块。

最后那条是重点：**`shared/` 下面不要建 `dto/`、`enums/`、`exceptions/` 这种按文件种类分的
目录。** 那等于把「按技术类型分」那套毛病换个地方再犯一遍——真正一起改的文件被拆散了，
而凑在一起的只是「碰巧都叫 dto」。

异常放哪儿同理：只有 greeting 会抛的 `GreetingAlreadyExistsException` 住在
`features/greeting/`；谁都可能抛的 `NotFoundException` 才进 `shared/http/`。而把异常翻译成
HTTP 状态码的 `http-error.handler.ts` 在 `infrastructure/web/`——它管的是**所有**异常，跟某
一个异常不构成一一对应，跟它绑死的是 HTTP 这个外部协议。

`shared/` 还有个坑要避开：**「A 模块的 DTO 被 B 模块用到了，所以挪进 shared」不算公用。**
那是耦合，挪进 shared 只是把它藏起来，A 改字段照样打到 B。正确做法是让 B 走 A 的 service
拿数据。判据是「这是谁都可能用的通用概念，还是某个模块的形状恰好被别人用了」。

`infrastructure/` 和 `features/` 的分界是「换掉它要不要改业务代码」：`GreetingService` 依赖的是
自己声明的 `GreetingStore` 接口，把内存实现换成 PostgreSQL 只需要新写一个
`implements GreetingStore` 的类，`features/` 一行都不用动。

`.reforce/` 和 `dist/` 都是产物，已经在 `.gitignore` 里。

## 模板里已经演示了什么

**依赖注入**：写进构造参数，容器按类型匹配。声明接口也行（`GreetingService` 就是这么拿到
`GreetingStore` 的）。同一个类型有多个实现时用 `@Primary` 或 `@Qualifier` 挑一个。新建一个类
打上 `@Injectable()` 就完事——编译期扫描整个 `src/`，不用登记，也不用从入口导出。

**请求校验**：`greeting.dto.ts` 里的 `params` / `query` / `body` 三个槽位。不合规的请求根本进不到
handler，直接 400 并带上出错的字段：

```bash
curl -i 'http://localhost:3000/greetings/world?times=99'
# 400 {"error":"request validation failed","source":"query","issues":[...]}
```

`z.coerce.number()` 顺手做了转换：查询串里是字符串 `"3"`，handler 里 `context.query.times`
已经是 number 了。

**响应白名单**：出参 schema 声明过的字段才会出线。`GreetingRecord` 上有个 `internalNote`，
handler 把整条记录原样返回，响应里也没有它——不靠人记得剥字段。

**分页**：形状收在 `shared/pagination/`，各 feature 只提供 item 的样子。

```bash
curl 'http://localhost:3000/greetings?page=1&size=10&order=desc'
```

**中间件（洋葱）**：`await next()` 之前是请求进来，之后是响应出去，一个类覆盖两相。阶段是
闭集，决定它在链上的哪一层：

| 阶段 | 干什么 | 模板里的例子 |
| --- | --- | --- |
| `observability` | 最外层，观测所有请求与最终响应 | `request-logging.middleware.ts` |
| `admission` | 认证 / 授权 / 限流，短路的典型位置 | `api-key.middleware.ts` |
| `application` | 默认阶段，贴近 handler 的业务拦截 | —— |

`global: true` 表示所有路由都走它；不写就只对用 `@Use` 显式挂上的路由生效（`api-key` 就是
这样只挂在写接口上）。不调 `next()` 直接返回响应即短路。

有个坑值得先知道：**handler 抛的异常和中间件抛的异常，出口不一样。** 前者在链的内层就被
error handler 换成了响应，外层中间件的 `await next()` 拿到的是正常 `Response`；后者走的是整条
链之外的错误出口，外层中间件的 `await next()` 直接抛。所以做访问日志的中间件必须自己
`try/catch`，否则被 `api-key` 挡下的请求在日志里根本不会出现——`request-logging.middleware.ts`
里那段 catch 就是干这个的。

**错误处理**：两级。service 只抛异常，不认识 HTTP；`http-error.handler.ts` 按表把已知异常翻译
成状态码，不认识的重新 throw；`fallback-error.handler.ts` 用更大的 `order` 排在后面兜底，把
堆栈打进日志、只回一句固定文案。

```bash
curl -i http://localhost:3000/greetings/nobody
# 404 {"error":"没有名为 nobody 的问候语。"}

curl -i -X POST http://localhost:3000/greetings \
  -H 'content-type: application/json' -d '{"name":"world","message":"再来一次"}'
# 409 {"error":"已经有名为 world 的问候语了。"}
```

**配置**：`config/` 下每个类一个前缀，字段名转成大写下划线就是环境变量名——`webServer` +
`port` → `WEB_SERVER_PORT`，`app` + `apiKey` → `APP_API_KEY`。

**健康检查**：`GET /health`。要部署就一定会被容器编排和负载均衡探到。

## 加东西的时候

**加一条路由**：controller 里加个方法，装饰器写 `@Get` / `@Post` 这些。schema 是可选的，但写了
就有两个好处——请求自动校验，`context.params` / `context.query` / `context.body` 也直接带上类型。
注意 schema 必须是 dto 文件里的**顶层具名导出**，写成内联字面量编译期找不到它。

**加一个模块**：照 `features/greeting/` 复制一份，改名就行。不用在任何地方注册。

**加一种异常**：只有一个模块会抛就放进那个模块目录（`greeting.exception.ts`），谁都可能抛
才进 `shared/http/`；两种都要往 `infrastructure/web/http-error.handler.ts` 的表里加一行。

不确定某个 bean 是从哪来的、某条路由怎么匹配的，问编译器：

```bash
pnpm exec reforce explain GreetingService
pnpm exec reforce explain "GET /greetings/:name"
```

它读的是 `.reforce/` 里的产物，所以先跑过一次 `dev` 或 `build`。

## 配置的逃生舱

`ConfigProperties` 换来的是四层 `.env` 叠加、启动期校验，以及报错时告诉你是哪个环境变量、
来自哪一层。如果一处配置简单到不值这些，直接绕开——引擎要的只是一个满足那个 ServeSettings
接口的 bean，谁来提供它框架不关心。下面两段里的 `ServeSettings` 就是
`config/web-server.config.ts` 里 `implements` 的那个类型，照抄那一行 `import` 即可：

```ts
import { defineBean } from "@reforce/core";

export const webServer = defineBean<ServeSettings>({
  create: () => ({ port: Number(process.env.PORT ?? 3000) }),
});
```

或者写成一个普通的类，需要注入别的 bean 时用这种：

```ts
@Injectable()
export class WebServerConfig implements ServeSettings {
  readonly port = Number(process.env.PORT ?? 3000);
}
```

代价说清楚：**`.env` 文件不再被读取**。加载 `.env` 是 `ConfigProperties` 那条路上的事，项目里
一个 `ConfigProperties` 都没有时，框架不会去碰 `.env`，`process.env.PORT` 就只能看见真实的进程
环境变量。校验失败的报错、拼错 key 的告警也一并没有。
