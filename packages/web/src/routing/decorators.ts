import type { BeanClass } from "@reforce/core";
import type { InferSchemaOutput, RequestContext } from "@/execution/request-context";
import type {
  ErrorHandlerOptions,
  MiddlewareOptions,
  RouteErrorHandler,
  RouteMiddleware,
} from "@/routing/middleware";
import { isWebPhase, type RouteSchemas } from "@/routing/vocabulary";

// 路由装饰器与 @Injectable 同款纪律（ADR 0006 W3）：编译期静态读取、运行时 no-op、标准
// TC39 装饰器。controller/中间件/错误处理器的 bean 身份由这些装饰器自身蕴含（编译器的
// analysis/bean-roles.ts），不再并列 @Injectable()。参数守卫服务未经编译的调用方（与
// Qualifier 同理）。

// controller 没有固定形状，不收紧；中间件与错误处理器有，各自钉死自己的契约。
type WebClassDecorator = <T extends BeanClass>(value: T, context: ClassDecoratorContext<T>) => void;

type MiddlewareClassDecorator = <T extends BeanClass<RouteMiddleware>>(
  value: T,
  context: ClassDecoratorContext<T>,
) => void;

type ErrorHandlerClassDecorator = <T extends BeanClass<RouteErrorHandler>>(
  value: T,
  context: ClassDecoratorContext<T>,
) => void;

// handler 契约在装饰器签名处钉死：方法要么零参、要么恰好接收 RequestContext<S>，返回值
// 由 response schema 决定——没声明 response 时 InferSchemaOutput 落回 unknown，等于不设限。
// `| Response` 分支保留 W5 的"Response 原样透传"契约。
//
// 这里给的是约束不是免标注：TS 不给类方法参数做上下文类型化（implements、抽象基类、
// 带实现的基类、装饰器签名四种形态实测都是 TS7006），所以 handler 仍要写
// `context: RequestContext<typeof schemas>`；装饰器负责校验这个标注与传入的 schemas 一致。
type RouteHandlerDecorator<S extends RouteSchemas> = <
  This,
  Value extends
    | ((this: This) => Awaitable<InferSchemaOutput<S["response"]> | Response>)
    | ((
        this: This,
        context: RequestContext<S>,
      ) => Awaitable<InferSchemaOutput<S["response"]> | Response>),
>(
  value: Value,
  context: ClassMethodDecoratorContext<This, Value>,
) => void;

type Awaitable<T> = T | Promise<T>;

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

function routeDecorator<S extends RouteSchemas>(
  name: string,
  path?: string,
  schemas?: S,
): RouteHandlerDecorator<S> {
  requireOptionalPath(name, path);
  requireOptionalSchemas(name, schemas);
  return () => undefined;
}

export function Delete<const S extends RouteSchemas = RouteSchemas>(
  path?: string,
  schemas?: S,
): RouteHandlerDecorator<S> {
  return routeDecorator("Delete", path, schemas);
}

export function Get<const S extends RouteSchemas = RouteSchemas>(
  path?: string,
  schemas?: S,
): RouteHandlerDecorator<S> {
  return routeDecorator("Get", path, schemas);
}

export function Head<const S extends RouteSchemas = RouteSchemas>(
  path?: string,
  schemas?: S,
): RouteHandlerDecorator<S> {
  return routeDecorator("Head", path, schemas);
}

export function Options<const S extends RouteSchemas = RouteSchemas>(
  path?: string,
  schemas?: S,
): RouteHandlerDecorator<S> {
  return routeDecorator("Options", path, schemas);
}

export function Patch<const S extends RouteSchemas = RouteSchemas>(
  path?: string,
  schemas?: S,
): RouteHandlerDecorator<S> {
  return routeDecorator("Patch", path, schemas);
}

export function Post<const S extends RouteSchemas = RouteSchemas>(
  path?: string,
  schemas?: S,
): RouteHandlerDecorator<S> {
  return routeDecorator("Post", path, schemas);
}

export function Put<const S extends RouteSchemas = RouteSchemas>(
  path?: string,
  schemas?: S,
): RouteHandlerDecorator<S> {
  return routeDecorator("Put", path, schemas);
}

export function Middleware(options: MiddlewareOptions = {}): MiddlewareClassDecorator {
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

export function ErrorHandler(options: ErrorHandlerOptions = {}): ErrorHandlerClassDecorator {
  if (options === null || typeof options !== "object") {
    throw new TypeError("ErrorHandler options must be an object when provided.");
  }
  requireOptionalOrder("ErrorHandler", options.order);
  return () => undefined;
}

// 挂载点（ADR 0006 W4）：@Use 在 controller 类上是路由组挂载、在 handler 方法上是单路由
// 挂载；顺序永远由中间件自身的 (phase, order, beanId) 决定，与挂载点和书写顺序无关。
export function Use(
  ...middleware: readonly BeanClass<RouteMiddleware>[]
): (value: unknown, context: ClassDecoratorContext | ClassMethodDecoratorContext) => void {
  for (const target of middleware) {
    if (typeof target !== "function") {
      throw new TypeError("Use only accepts middleware classes.");
    }
  }
  return () => undefined;
}
