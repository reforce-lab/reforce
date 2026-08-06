import type { ApplicationContext } from "@reforce/context";
import type { PreparedRoute, RequestSeeder, WebApplication } from "@/adapter";
import { InvalidRouteTableError } from "@/errors";
import { createErrorDispatcher, type ErrorDispatcher } from "@/execution/error-dispatch";
import { createRequestInputValidator } from "@/execution/input-validation";
import { RequestContextState } from "@/execution/request-context";
import { createResponseSerializer } from "@/execution/serialization";
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

// 洋葱链组装：middleware 数组顺序即外→内顺序（编译期压平写死）。next() 每层至多一次，
// 重复调用是中间件实现错误，原位拒绝而不是静默重跑内层。
function composeChain(middleware: readonly RouteMiddleware[], core: RouteRunner): RouteRunner {
  return (context) => {
    let nextIndex = 0;
    const dispatch = async (index: number): Promise<Response> => {
      if (index < nextIndex) {
        throw new Error("Middleware called next() more than once.");
      }
      nextIndex = index + 1;
      const entry = middleware[index];
      if (entry === undefined) {
        return await core(context);
      }
      return await entry.handle(context, () => dispatch(index + 1));
    };
    return dispatch(0);
  };
}

function prepareRoute(
  route: GeneratedRoute,
  context: ApplicationContext,
  dispatchError: ErrorDispatcher,
  requestSeeds: RequestSeeder | undefined,
  logger: RequestLogger | undefined,
): PreparedRoute {
  const controller = context.get(route.controller);
  const middleware = route.middleware.map((entry) =>
    requireMiddlewareInstance(context.get(entry.bean), entry.beanId),
  );
  const validateInputs = createRequestInputValidator(route.schemas);
  const serialize = createResponseSerializer(route.schemas.response);

  const core: RouteRunner = async (requestContext) => {
    try {
      await validateInputs(requestContext);
      return await serialize(await route.invoke(controller, requestContext));
    } catch (error) {
      requestContext.recordFailure(error);
      return await dispatchError(error, requestContext);
    }
  };
  const chain = composeChain(middleware, core);

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
      // 落在作用域**内部**：请求 bean 此刻已就位，LogFieldSource 能读到 trace id 之类的
      // 请求态字段。挪到外面就只剩静态字段了。
      return await context.runInRequestScope(seeds, async () => {
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
  };
}
