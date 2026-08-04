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

// 引擎无关的路由表消费（ADR 0006 W1/W4/W5）：启动时一次性完成 bean 解析、校验器与序列化器
// 特化、洋葱链组装；每条 PreparedRoute 的 handle 是适配器可直接挂进引擎的闭包，热路径零查表。
//
// 错误边界（W4 定案）是同一分派的两道防线：内层包住 校验+handler+序列化，让中间件的
// await next() 对核心错误永不抛（观测中间件因此看得到错误响应）；外层兜底包住整链，
// 中间件自身抛错也保证换成 Response——handle 永不 reject 是适配器契约的一部分。

export interface CreateWebApplicationOptions {
  readonly table: unknown;
  readonly context: ApplicationContext;
  // 每请求开启作用域时的根请求 bean 播种（ADR 0006 W7 / #151 接线面）；缺省不播种，
  // 请求计划照常执行。
  readonly requestSeeds?: RequestSeeder;
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
      return await dispatchError(error, requestContext);
    }
  };
  const chain = composeChain(middleware, core);

  return {
    method: route.method,
    path: route.path,
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
      return await context.runInRequestScope(seeds, async () => {
        try {
          return await chain(requestContext);
        } catch (error) {
          return await dispatchError(error, requestContext);
        }
      });
    },
  };
}

export function createWebApplication(options: CreateWebApplicationOptions): WebApplication {
  const table = validateGeneratedRouteTable(options.table);
  const dispatchError = createErrorDispatcher(
    table.errorHandlers.map((entry) =>
      requireErrorHandlerInstance(options.context.get(entry.bean), entry.beanId),
    ),
  );
  return {
    routes: table.routes.map((route) =>
      prepareRoute(route, options.context, dispatchError, options.requestSeeds),
    ),
  };
}
