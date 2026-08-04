import type { BeanClass } from "@reforce/context";
import type { RequestContext } from "@/execution/request-context";
import type { ErrorHandlerOptions, MiddlewareOptions } from "@/routing/middleware";
import { isWebPhase, type RouteSchemas } from "@/routing/vocabulary";

// 路由装饰器与 @Injectable 同款纪律（ADR 0006 W3）：编译期静态读取、运行时 no-op、标准
// TC39 装饰器。controller/中间件/错误处理器都是普通 bean——这里的标记只补充 web 语义，
// bean 身份仍由 @Injectable() 声明。参数守卫服务未经编译的调用方（与 Qualifier 同理）。

type WebClassDecorator = <T extends BeanClass>(value: T, context: ClassDecoratorContext<T>) => void;

// handler 契约在装饰器签名处钉死：方法要么零参、要么恰好接收 RequestContext，返回值
// 不设限（Response 原样透传，其余交给响应 schema 序列化）。
type RouteHandlerDecorator = <This, Value extends (this: This, context: RequestContext) => unknown>(
  value: Value,
  context: ClassMethodDecoratorContext<This, Value>,
) => void;

function requireOptionalPath(decorator: string, path: unknown): void {
  if (path !== undefined && typeof path !== "string") {
    throw new TypeError(`${decorator} path must be a string when provided.`);
  }
}

function requireOptionalSchemas(decorator: string, schemas: unknown): void {
  if (schemas === undefined) {
    return;
  }
  if (schemas === null || typeof schemas !== "object") {
    throw new TypeError(`${decorator} schemas must be an object when provided.`);
  }
}

function requireOptionalOrder(decorator: string, order: unknown): void {
  if (order !== undefined && (typeof order !== "number" || !Number.isInteger(order))) {
    throw new TypeError(`${decorator} order must be an integer when provided.`);
  }
}

export function Controller(path?: string): WebClassDecorator {
  requireOptionalPath("Controller", path);
  return () => undefined;
}

function routeDecorator(
  name: string,
  path?: string,
  schemas?: RouteSchemas,
): RouteHandlerDecorator {
  requireOptionalPath(name, path);
  requireOptionalSchemas(name, schemas);
  return () => undefined;
}

export function Delete(path?: string, schemas?: RouteSchemas): RouteHandlerDecorator {
  return routeDecorator("Delete", path, schemas);
}

export function Get(path?: string, schemas?: RouteSchemas): RouteHandlerDecorator {
  return routeDecorator("Get", path, schemas);
}

export function Head(path?: string, schemas?: RouteSchemas): RouteHandlerDecorator {
  return routeDecorator("Head", path, schemas);
}

export function Options(path?: string, schemas?: RouteSchemas): RouteHandlerDecorator {
  return routeDecorator("Options", path, schemas);
}

export function Patch(path?: string, schemas?: RouteSchemas): RouteHandlerDecorator {
  return routeDecorator("Patch", path, schemas);
}

export function Post(path?: string, schemas?: RouteSchemas): RouteHandlerDecorator {
  return routeDecorator("Post", path, schemas);
}

export function Put(path?: string, schemas?: RouteSchemas): RouteHandlerDecorator {
  return routeDecorator("Put", path, schemas);
}

export function Middleware(options: MiddlewareOptions = {}): WebClassDecorator {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Middleware options must be an object when provided.");
  }
  if (options.phase !== undefined && !isWebPhase(options.phase)) {
    throw new TypeError('Middleware phase must be "observability", "admission", or "application".');
  }
  requireOptionalOrder("Middleware", options.order);
  if (options.global !== undefined && typeof options.global !== "boolean") {
    throw new TypeError("Middleware global must be a boolean when provided.");
  }
  return () => undefined;
}

export function ErrorHandler(options: ErrorHandlerOptions = {}): WebClassDecorator {
  if (options === null || typeof options !== "object") {
    throw new TypeError("ErrorHandler options must be an object when provided.");
  }
  requireOptionalOrder("ErrorHandler", options.order);
  return () => undefined;
}

// 挂载点（ADR 0006 W4）：@Use 在 controller 类上是路由组挂载、在 handler 方法上是单路由
// 挂载；顺序永远由中间件自身的 (phase, order, beanId) 决定，与挂载点和书写顺序无关。
export function Use(
  ...middleware: readonly BeanClass[]
): (value: unknown, context: ClassDecoratorContext | ClassMethodDecoratorContext) => void {
  for (const target of middleware) {
    if (typeof target !== "function") {
      throw new TypeError("Use only accepts middleware classes.");
    }
  }
  return () => undefined;
}
