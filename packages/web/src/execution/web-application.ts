import type { ApplicationContext } from "@reforce/core";
import type { PreparedRoute, RequestSeeder, WebApplication } from "@/adapter";
import { InvalidRouteTableError, MiddlewareReenteredError } from "@/errors";
import { createErrorDispatcher, type ErrorDispatcher } from "@/execution/error-dispatch";
import { RequestContextState } from "@/execution/request-context";
import { runWithRequestFields } from "@/execution/request-fields";
import { serializeResponse } from "@/execution/serialization";
import { createSlotExecutor } from "@/execution/slot-execution";
import type { GeneratedRoute } from "@/generated/route-table";
import { validateGeneratedRouteTable } from "@/generated/validation";
import type { RouteErrorHandler, RouteMiddleware } from "@/routing/middleware";
import { metaLookup } from "@/routing/route-marker";

// 引擎无关的路由表消费（ADR 0006 W1/W4/W5）：启动时一次性完成 bean 解析、校验器与序列化器
// 特化、洋葱链组装；每条 PreparedRoute 的 handle 是适配器可直接挂进引擎的闭包，热路径零查表。
//
// 错误边界（W4 定案）是同一分派的两道防线：内层包住 校验+handler+序列化，让中间件的
// await next() 对核心错误永不抛（观测中间件因此看得到错误响应）；外层兜底包住整链，
// 中间件自身抛错也保证换成 Response——handle 永不 reject 是适配器契约的一部分。

// 框架输出需要的最小 logger 形状，由**消费侧**定义（同 ADR 0009 的 ReportedDiagnostic 先例）。
// @reforce/logging 的 Logger 结构性满足它们，生成的 bootstrap 直接把那个实例传进来。
//
// 不写成 `import type { Logger } from "@reforce/logging"`：type-only import 在运行时被擦除，
// 但**会留在生成的 d.ts 里**——那样每个消费 @reforce/web 的项目 typecheck 时都得解析得到
// @reforce/logging，等于把一条硬依赖藏在类型层。不写日志的应用不该为它多装一个包。
type LogFields = Readonly<Record<string, unknown>> | undefined;

/** 500 兜底要的最小形状（RFC 0011 C1，#250）：error-dispatch 只用得到这一个方法。 */
export interface ErrorLogger {
  error(fields: LogFields, message: string): void;
}

export interface RequestLogger extends ErrorLogger {
  isEnabled(level: RequestLogLevel): boolean;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
}

/** 请求日志用得到的三档；按状态码选（B1），对位 pino-http 的 customLogLevel 缺省行为。 */
type RequestLogLevel = "info" | "warn" | "error";

// 5xx→error、4xx→warn、其余 info。此前一律 info——`status=500` 与 `status=200` 同级别，
// 意味着按级别过滤的告警规则对服务端错误完全瞎。
function levelForStatus(status: number): RequestLogLevel {
  if (status >= 500) {
    return "error";
  }
  return status >= 400 ? "warn" : "info";
}

export interface CreateWebApplicationOptions {
  readonly table: unknown;
  readonly context: ApplicationContext;
  // 每请求开启作用域时的根请求 bean 播种（ADR 0006 W7 / #151 接线面）；缺省不播种，
  // 请求计划照常执行。
  readonly requestSeeds?: RequestSeeder;
  // 请求日志由核心统一发（RFC 0011 L6，#250），不由各引擎各写一遍——三个引擎写出来的字段
  // 必然漂移，而请求日志是最需要跨引擎可比的一条。缺席即不打。
  readonly logger?: RequestLogger;
}

// 记的是 handler 的耗时，字段名如实叫 handlerMs 而不是 durationMs（L6 的诚实边界）：
// 这一刻拿到的是「Response 对象已产生」，**不是「字节已送出」**。流式响应（无 content-length）
// 此刻 body 还没写完。真实的 duration 与 bytes 只能在引擎侧的 finish 监听上拿，那是后续的事，
// 现在把名字取准，免得将来发现数字对不上还得改字段名。
function logRequest(input: {
  readonly logger: RequestLogger | undefined;
  readonly method: string;
  readonly path: string;
  readonly response: Response;
  readonly startedAt: number;
  /** handler 抛出的错误（B2，#250）；被 dispatchError 换成响应后它就是唯一的线索。 */
  readonly error?: unknown;
}): void {
  const level = levelForStatus(input.response.status);
  // 不变量 8：字段对象在调用之前就构造好了，所以判定必须在这里做，不能指望 logger 内部短路。
  // 级别判定同样必须在字段构造**之前**——它决定要不要构造。
  if (input.logger?.isEnabled(level) !== true) {
    return;
  }
  input.logger[level](
    {
      method: input.method,
      path: input.path,
      status: input.response.status,
      handlerMs: Math.round((performance.now() - input.startedAt) * 1000) / 1000,
      // err 是保留字段名：pino/bunyan/OTel 都按它特判 Error 序列化。没有错误时不写这个键，
      // 免得每条正常请求都多一个恒为 undefined 的字段。
      ...(input.error === undefined ? {} : { err: input.error }),
    },
    "request",
  );
}

// 日志系统自己坏了不能连累一次已经答完的 404，但也不许一声不吭（不变量 9）。每个应用实例
// 只喊一次（闭包字段而不是模块级单例：testing 的多 context 并存与 dev 重启会复用同一进程，
// 上一个实例喊过就把下一个实例的唯一一声吞掉）；这条路径由客户端触发，扫描器一秒几百下，
// 喊多了它自己就成了刷屏源。
function createNotFoundLogger(
  logger: RequestLogger,
): (miss: { readonly method: string; readonly path: string }) => void {
  let missLoggerFailureReported = false;
  return (miss) => {
    // 不变量 8：判定在字段构造之前。
    //
    // 级别取 info 而不是 levelForStatus 的 4xx→warn：路由未命中不是应用出错——没有 handler
    // 跑过，也没有任何东西行为异常；而且这条记录的级别完全由客户端说了算，任何人都能靠请求
    // 不存在的路径把 warn 刷满，扫描器每天的 /wp-login.php 会把告警面淹掉。需要告警的人按
    // status=404 自己筛。
    if (!logger.isEnabled("info")) {
      return;
    }
    try {
      // message 不复用 "request"：两条记录的 path 基数不同——请求日志的 path 是编译期路由
      // 模式（有界，可安全聚合），这里的是客户端完全控制的原始路径（无界）。
      // 不写 handlerMs：什么都没跑过，写 0 就是假的。
      logger.info({ method: miss.method, path: miss.path, status: 404 }, "route not found");
    } catch (error) {
      if (missLoggerFailureReported) {
        return;
      }
      missLoggerFailureReported = true;
      process.stderr.write(`[reforce.web] the 404 logger failed: ${String(error)}\n`);
    }
  };
}

type RouteRunner = (context: RequestContextState) => Promise<Response>;

function requireMiddlewareInstance(instance: object, beanId: string): RouteMiddleware {
  if (typeof Reflect.get(instance, "handle") !== "function") {
    throw new InvalidRouteTableError(`middleware Bean "${beanId}" does not implement handle().`);
  }
  // handle 存在性已复检；洋葱契约的参数形状由生成物的 BeanClass<RouteMiddleware> 类型边
  // 背书，运行时无从进一步窄化 // justified: 见上一行
  return instance as RouteMiddleware;
}

function requireErrorHandlerInstance(instance: object, beanId: string): RouteErrorHandler {
  if (typeof Reflect.get(instance, "handle") !== "function") {
    throw new InvalidRouteTableError(`error handler Bean "${beanId}" does not implement handle().`);
  }
  // 同 requireMiddlewareInstance：存在性已复检，契约形状由生成物类型边背书
  // // justified: 见上一行
  return instance as RouteErrorHandler;
}

interface ChainLink {
  readonly beanId: string;
  readonly middleware: RouteMiddleware;
}

// 洋葱链组装：middleware 数组顺序即外→内顺序（编译期压平写死）。next() 每层至多一次，
// 重复调用是中间件实现错误，原位拒绝而不是静默重跑内层。
//
// 守卫挂在每层自己的 next 闭包上而不是共享游标（#255）：出错时要点名是哪个中间件，闭包里
// link 是词法可见的，用 dispatch 下标反查还要处理越界、还容易写反。语义与共享游标版一致——
// 每个 next 只会调一次 dispatch(index + 1)，所以「游标退了」与「这个 next 被调了第二次」
// 本来就是同一件事；entered 在第一个 await 之前同步置位，未 await 的重复调用照样被拒。
function composeChain(
  links: readonly ChainLink[],
  route: Pick<GeneratedRoute, "method" | "path">,
  core: RouteRunner,
): RouteRunner {
  return (context) => {
    const dispatch = async (index: number): Promise<Response> => {
      const link = links[index];
      if (link === undefined) {
        return await core(context);
      }
      let entered = false;
      const next = async (): Promise<Response> => {
        if (entered) {
          throw new MiddlewareReenteredError({
            beanId: link.beanId,
            method: route.method,
            path: route.path,
          });
        }
        entered = true;
        return await dispatch(index + 1);
      };
      return await link.middleware.handle(context, next);
    };
    return dispatch(0);
  };
}

// 响应头合并范围(RFC 0012 S2,#274 推断口径,PR 描述写明):只合并编码/序列化产出的响应;
// handler 直接返回的 Response(逃生口)与 400/500 错误响应不碰——前者是用户全权掌控的出口,
// 后者由错误分派统一负责,handler 半路写下的头不该跟着错误出线。
function mergeResponseHeaders(response: Response, headers: Headers): void {
  for (const [name, value] of headers) {
    // Headers 迭代对 set-cookie 逐条产出、其余同名键并成逗号串;set-cookie 必须逐条 append
    // (逗号串会被浏览器当一条 cookie),其余用 set 让 handler 声明的头覆盖序列化默认值。
    if (name === "set-cookie") {
      response.headers.append(name, value);
    } else {
      response.headers.set(name, value);
    }
  }
}

function prepareRoute(
  route: GeneratedRoute,
  context: ApplicationContext,
  dispatchError: ErrorDispatcher,
  requestSeeds: RequestSeeder | undefined,
  logger: RequestLogger | undefined,
): PreparedRoute {
  const controller = context.get(route.controller);
  // beanId 留到运行期只为重入拒绝点名（#255）；热路径不读它，解析仍是启动期一次性的。
  const middleware = route.middleware.map((entry) => ({
    beanId: entry.beanId,
    middleware: requireMiddlewareInstance(context.get(entry.bean), entry.beanId),
  }));
  const executeSlots = createSlotExecutor(route.slots);

  const core: RouteRunner = async (requestContext) => {
    try {
      const slots = await executeSlots(requestContext);
      const result = await route.invoke(controller, requestContext, slots);
      const response = serializeResponse(result, route.encode);
      if (!(result instanceof Response)) {
        mergeResponseHeaders(response, requestContext.responseHeaders);
      }
      return response;
    } catch (error) {
      requestContext.recordFailure(error);
      return await dispatchError(error, requestContext);
    }
  };
  const chain = composeChain(middleware, route, core);

  return {
    method: route.method,
    path: route.path,
    meta: metaLookup(route.meta),
    async handle(request, params) {
      const requestContext = new RequestContextState({
        request,
        url: new URL(request.url),
        method: route.method,
        path: route.path,
        params,
        meta: route.meta,
      });
      const seeds =
        requestSeeds?.(request, {
          method: route.method,
          path: route.path,
          params,
          meta: route.meta,
        }) ?? [];
      // 请求字段先入场再开作用域（RFC 0011 L4，#242）：ALS 只向内传播，所以请求 bean 的构造
      // 与整条中间件链都在它里面——这一段里任何一条应用日志都自带 method 与 path。
      return await runWithRequestFields({ method: route.method, path: route.path }, async () =>
        // 日志落在作用域**内部**：请求 bean 此刻已就位，LogFieldSource 能读到 trace id 之类的
        // 请求态字段。挪到外面就只剩静态字段了。
        context.runInRequestScope(seeds, async () => {
          const startedAt = performance.now();
          // 两条出口都要量到：正常返回与 dispatchError 返回都是「这个请求结束了」。外层 catch
          // 保证 handle 永不 reject，所以「结束」处一定有一个 Response。
          const response = await (async () => {
            try {
              return await chain(requestContext);
            } catch (error) {
              requestContext.recordFailure(error);
              return await dispatchError(error, requestContext);
            }
          })();
          // 日志失败绝不能把请求带下去：`handle` 永不 reject 是适配器契约的一部分（#226），而
          // 这里的 logger 是用户的——pino 的 serializer、LogFieldSource.fields()、isEnabled 都
          // 可能抛。真抛了就丢这一条，已经做好的响应照常送出。
          try {
            logRequest({
              logger,
              method: route.method,
              path: route.path,
              response,
              startedAt,
              error: requestContext.failure,
            });
          } catch {
            // 记不上就记不上，不值得赔上一个已经成功的响应。
          }
          return response;
        }),
      );
    },
  };
}

// controller 数只有这里数得出：PreparedRoute 刻意不外露 controller bean（引擎不该拿到它），
// 而启动摘要的折叠行要它（不变量 4：折叠必带计数）。所以它走这条非适配器的返回类型——
// 引擎看到的仍是 WebApplication，多出来的字段只有 connectWebApplication 消费。
export interface PreparedWebApplication extends WebApplication {
  readonly controllerCount: number;
}

export function createWebApplication(options: CreateWebApplicationOptions): PreparedWebApplication {
  const table = validateGeneratedRouteTable(options.table);
  const dispatchError = createErrorDispatcher(
    table.errorHandlers.map((entry) =>
      requireErrorHandlerInstance(options.context.get(entry.bean), entry.beanId),
    ),
    options.logger,
  );
  return {
    routes: table.routes.map((route) =>
      prepareRoute(route, options.context, dispatchError, options.requestSeeds, options.logger),
    ),
    controllerCount: new Set(table.routes.map((route) => route.controller)).size,
    ...(options.logger === undefined ? {} : { logNotFound: createNotFoundLogger(options.logger) }),
  };
}
