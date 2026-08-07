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
      greeting.controller.ts              路由：路径、方法，契约都在参数和返回类型的标注上
      greeting.service.ts                 业务规则 + 它需要的端口（GreetingStore 接口）
      greeting.dto.ts                     进出的形状：请求 schema + 响应 interface
      greeting.exception.ts               只有这个模块会抛的业务异常（一行一个）
    health/
      health.controller.ts                健康检查（没有业务规则，就不必造 service 和 dto）
  infrastructure/                       和外部世界、和框架接壤的适配件
    web/                                  HTTP 这一面
      request.fields.ts                    请求期间的日志自动带上 method、path、requestId
      api-key.middleware.ts                写接口的准入检查（admission）
    persistence/                           存储这一面
      in-memory-greeting.store.ts          换数据库时只改这里
  shared/                               跨模块的公共词汇
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

异常放哪儿同理：只有 greeting 会抛的 `GreetingAlreadyExists` 住在 `features/greeting/`。
通用的 404 / 401 / 403 / 409 不用你定义，`@reforce/web` 直接导出 `NotFoundError` 等五个，
`import` 就能抛。

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

**请求校验**：handler 参数的类型标注就是输入契约。`Body<CreateGreetingBody>` 表示「请求体按
这个契约校验后整体给我」，`Param<GreetingParams, "name">` 是投影写法——校验仍按整个契约跑，
参数值只取 `name` 这一个字段。类型别名经 `z.infer<typeof x>` 追溯到 dto 里的 zod schema，
校验就交给它。不合规的请求根本进不到 handler，直接 400 并带上出错的字段：

```bash
curl -i 'http://localhost:3000/greetings/world?times=99'
# 400 application/problem+json
# {"type":"about:blank","title":"Bad Request","status":400,
#  "code":"REQUEST_VALIDATION_FAILED","source":"query","issues":[...]}
```

`z.coerce.number()` 顺手做了转换：查询串里是字符串 `"3"`，handler 拿到的 `times` 已经是
number 了。schema 不是必须的：参数直接标 `Query<"page", number>` 这种单键写法，编译器会按
类型生成解码器，字符串转数字、非法值 400 都一样有——schema 的价值在 min/max 这类值域规则。

**响应契约**：handler 的**返回类型**就是线上形状，声明过的字段才会出线。`GreetingRecord` 上
有个 `internalNote`，handler 把整条记录原样返回，响应里也没有它——不靠人记得剥字段。响应侧
不需要 schema，一个 interface（如 `GreetingView`）就够；连返回类型都不标时，编译器按推导
结果给同样的白名单。`@ResponseStatus(201)` 改掉成功状态码（见 `create`），缺省 200。

**分页**：形状收在 `shared/pagination/`，各 feature 只提供 item 的样子。

```bash
curl 'http://localhost:3000/greetings?page=1&size=10&order=desc'
```

**中间件（洋葱）**：`await next()` 之前是请求进来，之后是响应出去，一个类覆盖两相。阶段是
闭集，决定它在链上的哪一层：

| 阶段 | 干什么 | 模板里的例子 |
| --- | --- | --- |
| `observability` | 最外层，观测所有请求与最终响应 | ——（访问日志框架自带，见「日志」） |
| `admission` | 认证 / 授权 / 限流，短路的典型位置 | `api-key.middleware.ts` |
| `application` | 默认阶段，贴近 handler 的业务拦截 | —— |

`global: true` 表示所有路由都走它；不写就只对用 `@Use` 显式挂上的路由生效（`api-key` 就是
这样只挂在写接口上）。不调 `next()` 直接返回响应即短路。

有个坑值得先知道：**handler 抛的异常和中间件抛的异常，出口不一样。** 前者在链的内层就被
error handler 换成了响应，外层中间件的 `await next()` 拿到的是正常 `Response`；后者走的是整条
链之外的错误出口，外层中间件的 `await next()` 直接抛。自己写 observability 中间件时必须
`try/catch` 把两条出口都接住，否则被 `api-key` 挡下的请求会从你的统计里凭空消失。框架自带的
访问日志在整条链**之外**统一记，两条出口都盖到，所以模板没有再写一个访问日志中间件。

**日志**：`application.ts` 里注册的 `logging` starter 包办两件事。启动时打一份摘要——bean 数、
路由数、**监听地址**、ready 耗时；运行期每个请求记一条访问日志（2xx/3xx 是 info、4xx 是 warn、
5xx 是 error，带 method / path / status / handlerMs），admission 挡下的 401 和中间件抛的异常也在
里面，不会有请求消失。`request.fields.ts` 再补一块：请求期间你自己打的日志自动带上 method、
path 和 requestId。输出形态自适应——终端里给人读，重定向到文件或容器采集时自动换成 JSON 行。

request id 是内建的，不用配：每个响应都带 `x-request-id` 头（客户端带了合法值就回显，否则
生成一个），日志里的 `requestId` 和它是同一个值——用户报一个 id，日志里一次 grep 就到现场。

默认级别是 info。调级别不用环境变量，写一个普通 bean（级别拼错是编译错误，logger 名拼错
启动时会得到告警）：

```ts
import { Injectable } from "@reforce/core";
import type { LoggerLevelMap, LoggingSettings } from "@reforce/logging";

@Injectable()
export class AppLogging implements LoggingSettings {
  readonly levels = { "reforce.core": "debug" } satisfies LoggerLevelMap;
}
```

**错误处理**：**你什么都不用写。** 异常自己带着状态码与码（`NotFoundError` 带 404，
`defineHttpError(..., 409)` 带 409），框架把它渲染成 [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)
的 `application/problem+json`。没人认领的错误一律 500，堆栈只进日志，响应里只给一个
`errorId` 供你在日志里 grep——消息、堆栈、内部字段都不会漏出去。

```bash
curl -i http://localhost:3000/greetings/nobody
# 404 application/problem+json
# {"type":"about:blank","title":"Not Found","status":404,
#  "detail":"没有名为 nobody 的问候语。","code":"WEB_NOT_FOUND"}

curl -i -X POST http://localhost:3000/greetings \
  -H 'content-type: application/json' -d '{"name":"world","message":"再来一次"}'
# 409 {"type":"about:blank","title":"Conflict","status":409,
#      "detail":"已经有名为 world 的问候语了。","code":"GREETING_ALREADY_EXISTS"}
```

客户端按 `code` 分派，不要匹配 `detail`：码是稳定契约，文案随时会改。

真要接管某一类错误（换个响应体、加个 header、上报到监控），写一个 `@ErrorHandler()` bean：
返回 `Response` 就算接管，重新 `throw` 就交给下一个，全都放弃了框架才兜底。**别写
catch-all**——那会把框架的校验 400 也变成 500，用户就再也看不到「哪个字段不合法」。

**配置**：`config/` 下每个类一个前缀，字段名转成大写下划线就是环境变量名——`webServer` +
`port` → `WEB_SERVER_PORT`，`app` + `apiKey` → `APP_API_KEY`。

**健康检查**：`GET /health`。要部署就一定会被容器编排和负载均衡探到。

## 加东西的时候

**加一条路由**：controller 里加个方法，装饰器写 `@Get` / `@Post` 这些；输入写成参数标注
（`Param<...>` / `Query<...>` / `Body<...>`），输出写返回类型，契约就齐了。要值域校验就在 dto
里建 zod schema 加 `z.infer` 别名——注意 schema 必须是**顶层具名导出**，写成内联字面量
编译期找不到它；不需要值域校验就直接标类型，编译器生成解码器。

**加一个模块**：照 `features/greeting/` 复制一份，改名就行。不用在任何地方注册。

**加一种异常**：通用的直接用 `@reforce/web` 的 `NotFoundError` / `UnauthorizedError` /
`ForbiddenError` / `ConflictError` / `BadRequestError`。要带自己的码（让调用方能按程序分派）
就 `defineHttpError("YOUR_CODE", "文案 %s。", 409)`，放进那个模块的 `*.exception.ts`。
**没有表要维护**——状态码写在异常自己身上。

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
