import type { ApplicationContext, RequestScopeSeed } from "@reforce/core";
import type { PreparedRoute, RequestSeeder, WebApplication } from "@/adapter";
import { InvalidRouteTableError, MiddlewareReenteredError } from "@/errors";
import { createErrorDispatcher, type ErrorDispatcher } from "@/execution/error-dispatch";
import { RequestContextState } from "@/execution/request-context";
import { runWithRequestFields, type WebRequestFacts } from "@/execution/request-fields";
import { requestIdHeader, resolveRequestId } from "@/execution/request-id";
import { type RouteResponse, toRouteResponse } from "@/execution/route-response";
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
// 但**会留在生成的 d.ts 里**——那样每个消费 @reforce/web-core 的项目 typecheck 时都得解析得到
// @reforce/logging，等于把一条硬依赖藏在类型层。不写日志的应用不该为它多装一个包。
type LogFields = Readonly<Record<string, unknown>> | undefined;

// 没装 seeder 的应用此前每请求造一个空数组（`?? []`，#380）。冻结是为了让这个共享实例
// 不可能被下游写坏。
const emptySeeds: readonly RequestScopeSeed[] = Object.freeze([]);

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
  readonly requestId: string;
  readonly response: RouteResponse;
  /**
   * 请求开始那一刻的 performance.now()，**没装 logger 时是 undefined**（#380）：这两次取时
   * 只有请求日志消费，没有消费方就一次都不该取。它与 logger 由同一个条件产生，但类型系统
   * 表达不了这条耦合，所以下面各查一次。
   */
  readonly startedAt: number | undefined;
  /** handler 抛出的错误（B2，#250）；被 dispatchError 换成响应后它就是唯一的线索。 */
  readonly error?: unknown;
}): void {
  const level = levelForStatus(input.response.status);
  // 不变量 8：字段对象在调用之前就构造好了，所以判定必须在这里做，不能指望 logger 内部短路。
  // 级别判定同样必须在字段构造**之前**——它决定要不要构造。
  if (input.startedAt === undefined || input.logger?.isEnabled(level) !== true) {
    return;
  }
  input.logger[level](
    {
      method: input.method,
      path: input.path,
      // 请求日志直写 requestId(#303):没注册 LogFieldSource 的应用也拿得到;注册了的话
      // 贡献者与这里是同一个值,同键同值无冲突。
      requestId: input.requestId,
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

type RouteRunner = (context: RequestContextState) => Promise<RouteResponse>;

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
    const dispatch = async (index: number): Promise<RouteResponse> => {
      const link = links[index];
      if (link === undefined) {
        return await core(context);
      }
      let entered = false;
      const next = async (): Promise<RouteResponse> => {
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
      // 中间件的返回值可以是内部货币，也可以是它自己造的标准 Response（逃生口与 handler
      // 同规则，#340 决议 1）；两者在这里收敛成同一种东西。
      return toRouteResponse(await link.middleware.handle(context, next), context);
    };
    return dispatch(0);
  };
}

// 响应头不再需要「合并」(#340 决议 2):序列化器、错误分派、dev 错误页与 handler/中间件写的
// 都是 `RequestContext.responseHeaders` 那**一个** Headers 实例,因此没有两份头要对齐,
// mergeResponseHeaders 连同它那条「只合并编码产出的响应、不碰逃生口与错误响应」的例外规则
// (RFC 0012 S3 / #275 拍板 3)一并删除。语义收敛为一条无例外的规则:写在 context 上的响应头
// 一定出站。

/**
 * 每请求「入场」：在跑这一条路由之前把请求作用域开好。启动期从三档里挑一档定死（#380）。
 *
 * 挑法只看**声明**，不看函数体，因为三个判据全是编译期事实：有没有请求作用域 bean 是生成物
 * 里的 requestConstructionOrder（core 没有条件注册），有没有 logger 是生成的 bootstrap 传不传
 * 那个参数。request-id 不进判据——响应头那个 id 是传值的，全程不经 ALS。
 *
 * 粒度是应用级不是路由级：路由级只在「没 logger、没请求 bean、但少数路由有请求 bean」这个
 * 很窄的组合里多省一点，而只要注册了 logger 全应用都得开，那份复杂度就白花了。
 */
type RequestEntry = (
  requestContext: RequestContextState,
  requestId: string,
  run: () => Promise<RouteResponse>,
) => Promise<RouteResponse>;

// 请求事实对象在这里造，因为只有开了作用域才有人读得到它（#380）：第三档一次都不造。
function requestFactsOf(requestContext: RequestContextState, requestId: string): WebRequestFacts {
  return { method: requestContext.method, path: requestContext.path, requestId };
}

function createRequestEntry(options: CreateWebApplicationOptions): RequestEntry {
  const { context, requestSeeds } = options;
  if (context.hasRequestScopedBeans) {
    // DI 必须靠这一仓定位请求 bean 实例，所以这一档非开不可；请求事实顺路挂在同一个 store 上。
    if (requestSeeds === undefined) {
      // 没装 seeder：共用一个冻结空数组，此前每请求造一个新的（#380）。
      return (requestContext, requestId, run) =>
        context.runInRequestScope(emptySeeds, run, requestFactsOf(requestContext, requestId));
    }
    return (requestContext, requestId, run) => {
      const facts = requestFactsOf(requestContext, requestId);
      // seeds 必须在开仓之前算好，而 seeder 读得到 currentRequestId 是 #303 立下的行为，
      // 所以这一段单独套一次事实作用域。只有真的装了 seeder 的应用付这次 run()。
      // 交给 seeder 的就是 requestContext 本身（#341）：要标准 Request 就读 `context.request`，
      // 不读就一次都不物化。
      const seeds = runWithRequestFields(facts, () => requestSeeds(requestContext));
      return context.runInRequestScope(seeds, run, facts);
    };
  }
  if (options.logger !== undefined) {
    // 没有请求 bean 但有 logger：应用日志每条要自带 method/path/requestId，这是请求事实存在的
    // 全部理由。开一个只带事实的作用域，不建仓、不走空的请求构造计划。
    return (requestContext, requestId, run) =>
      runWithRequestFields(requestFactsOf(requestContext, requestId), run);
  }
  // 两者都没有：一次 run() 都不开。已知洞（接受）：这种配置下调 currentRequestId() 拿到
  // undefined 且不报错——编译期看不见函数体里的自由函数调用，堵不住；而这种配置下本来就
  // 没有任何东西在消费 request id。
  return (_requestContext, _requestId, run) => run();
}

function prepareRoute(
  route: GeneratedRoute,
  context: ApplicationContext,
  dispatchError: ErrorDispatcher,
  enterRequest: RequestEntry,
  logger: RequestLogger | undefined,
): PreparedRoute {
  const controller = context.get(route.controller);
  // beanId 留到运行期只为重入拒绝点名（#255）；热路径不读它，解析仍是启动期一次性的。
  const middleware = route.middleware.map((entry) => ({
    beanId: entry.beanId,
    middleware: requireMiddlewareInstance(context.get(entry.bean), entry.beanId),
  }));
  const executeSlots = createSlotExecutor(route.slots);
  // 启动期算一次，PreparedRoute.meta 与每请求的 RequestContextState 共用同一个闭包（#380）。
  const lookupMeta = metaLookup(route.meta);

  const core: RouteRunner = async (requestContext) => {
    try {
      const slots = await executeSlots(requestContext);
      const result = await route.invoke(controller, requestContext, slots);
      return serializeResponse(result, route.response, requestContext.responseHeaders);
    } catch (error) {
      requestContext.recordFailure(error);
      return await dispatchError(error, requestContext);
    }
  };
  const chain = composeChain(middleware, route, core);

  return {
    method: route.method,
    path: route.path,
    meta: lookupMeta,
    async handle(request, params) {
      // request id(#303):回显合法客户端值,否则生成——请求进 handle 的第一件事,
      // 后面的 seeder、请求 bean、每条应用日志与响应头共享同一个值。
      const requestId = resolveRequestId(request);
      const requestContext = new RequestContextState({
        incoming: request,
        method: route.method,
        path: route.path,
        params,
        meta: lookupMeta,
      });
      // 整条链都在作用域里（RFC 0011 L4，#242）：ALS 只向内传播，所以请求 bean 的构造与整条
      // 中间件链都要在它里面——这一段里任何一条应用日志才自带 method 与 path，LogFieldSource
      // 也才读得到 trace id 之类的请求态字段。
      return await enterRequest(requestContext, requestId, async () => {
        // 两条出口都要量到：正常返回与 dispatchError 返回都是「这个请求结束了」。外层 catch
        // 保证 handle 永不 reject，所以「结束」处一定有一个 Response。
        const startedAt = logger === undefined ? undefined : performance.now();
        // 此前这里包着一个 async IIFE，只为在 try/catch 之后还能读到 response（#380）：
        // 每请求白付一个 async frame。改成先声明后赋值，两条分支都必赋值。
        let response: RouteResponse;
        try {
          response = await chain(requestContext);
        } catch (error) {
          requestContext.recordFailure(error);
          response = await dispatchError(error, requestContext);
        }
        // 统一缝盖章(#303):编码响应/直返 Response/400/500/中间件抛错的外层兜底,全部
        // 出口都经过这里。
        // 无条件 set——不变量是「客户端可见 id ≡ 日志 id」,覆盖用户手写头。#340 之后
        // 这里操作的恒是框架自己那个 Headers（逃生口的头是被**拷贝**进来的，不是借用
        // 用户那个实例），所以不再有 fetch 代理 Response 的 immutable headers 会抛的
        // 情况，那道 try/catch 已成死代码，删除。
        response.headers.set(requestIdHeader, requestId);
        // 日志失败绝不能把请求带下去：`handle` 永不 reject 是适配器契约的一部分（#226），而
        // 这里的 logger 是用户的——pino 的 serializer、LogFieldSource.fields()、isEnabled 都
        // 可能抛。真抛了就丢这一条，已经做好的响应照常送出。
        try {
          logRequest({
            logger,
            method: route.method,
            path: route.path,
            requestId,
            response,
            startedAt,
            error: requestContext.failure,
          });
        } catch {
          // 记不上就记不上，不值得赔上一个已经成功的响应。
        }
        return response;
      });
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
    table.errorHandlers.map((entry) => ({
      handler: requireErrorHandlerInstance(options.context.get(entry.bean), entry.beanId),
      ...(entry.accepts === undefined ? {} : { accepts: entry.accepts }),
      ...(entry.status === undefined ? {} : { status: entry.status }),
      ...(entry.encode === undefined ? {} : { encode: entry.encode }),
    })),
    options.logger,
  );
  const enterRequest = createRequestEntry(options);
  return {
    routes: table.routes.map((route) =>
      prepareRoute(route, options.context, dispatchError, enterRequest, options.logger),
    ),
    controllerCount: new Set(table.routes.map((route) => route.controller)).size,
    ...(options.logger === undefined ? {} : { logNotFound: createNotFoundLogger(options.logger) }),
  };
}
