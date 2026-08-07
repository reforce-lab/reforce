import type { BeanClass } from "@reforce/core";
import type {
  ErrorHandlerOptions,
  MiddlewareOptions,
  RouteErrorHandler,
  RouteMiddleware,
} from "@/routing/middleware";
import { isWebPhase } from "@/routing/vocabulary";

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

// 槽位写法(RFC 0012 S2,#274)下 handler 参数列表放开为任意形态:每个参数的槽位合法性
// 由编译器逐参数裁决(六类硬错),装饰器签名不再复述。约束必须逐字复刻 lib 里
// ClassMethodDecoratorContext 对 Value 的上界 `(this, ...args: any) => any`——写成更窄的
// never[]/unknown 形态会在 context 形参处触发 TS2344(any 不可赋给 never)。
type RouteHandlerDecorator = <
  This,
  // biome-ignore lint/suspicious/noExplicitAny: lib.decorators 的 ClassMethodDecoratorContext 上界即为 any,复刻之
  Value extends (this: This, ...args: any) => any,
>(
  value: Value,
  context: ClassMethodDecoratorContext<This, Value>,
) => void;

function requireOptionalPath(decorator: string, path: unknown): void {
  if (path !== undefined && typeof path !== "string") {
    throw new TypeError(`${decorator} path must be a string when provided.`);
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

function routeDecorator(name: string, path?: string): RouteHandlerDecorator {
  requireOptionalPath(name, path);
  return () => undefined;
}

export function Delete(path?: string): RouteHandlerDecorator {
  return routeDecorator("Delete", path);
}

export function Get(path?: string): RouteHandlerDecorator {
  return routeDecorator("Get", path);
}

export function Head(path?: string): RouteHandlerDecorator {
  return routeDecorator("Head", path);
}

export function Options(path?: string): RouteHandlerDecorator {
  return routeDecorator("Options", path);
}

export function Patch(path?: string): RouteHandlerDecorator {
  return routeDecorator("Patch", path);
}

export function Post(path?: string): RouteHandlerDecorator {
  return routeDecorator("Post", path);
}

export function Put(path?: string): RouteHandlerDecorator {
  return routeDecorator("Put", path);
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
