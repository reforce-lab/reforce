import type { BeanClass } from "@reforce/core";
import type { RequestContext } from "@/execution/request-context";
import type { RouteErrorHandler, RouteMiddleware } from "@/routing/middleware";
import type { HttpMethod, RouteMetaValue, RouteSchemas, WebPhase } from "@/routing/vocabulary";

// 路由表生成物契约（ADR 0006 W1/W2，#142 / #152）：与 @reforce/core 的
// GeneratedApplicationDefinition 同等纪律的版本化公开面——编译器 emission、routes.json、
// 本文件三处共享同一形状，schemaVersion 是硬版本门，演进必须显式升版而非打补丁。

export type GeneratedMiddlewareMount = "controller" | "global" | "route";

export interface GeneratedRouteMiddleware {
  // BeanClass<RouteMiddleware> 是 typed-edge 纪律的延伸：生成的 routes.ts 引用中间件类时，
  // tsc 顺带背书该类实现了洋葱契约。
  readonly bean: BeanClass<RouteMiddleware>;
  readonly beanId: string;
  readonly phase: WebPhase;
  readonly order: number;
  readonly mount: GeneratedMiddlewareMount;
}

export interface GeneratedRoute<T extends object = object> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly controller: BeanClass<T>;
  readonly beanId: string;
  readonly handler: string;
  // 方法语法声明（双变参数）：生成物里每条 invoke 闭包携带具体 controller 类型，装进
  // GeneratedRoute<object> 数组仍可赋值；tsc 借闭包体背书 handler 方法存在且接收
  // RequestContext。运行时只以本 route 的 controller 实例调用它。
  invoke(instance: T, context: RequestContext): unknown;
  // 压平后的完整链（ADR 0006 W4）：数组顺序即执行顺序（外→内），编译期按
  // (阶段, order, beanId) 决胜写死，运行时零决策。
  readonly middleware: readonly GeneratedRouteMiddleware[];
  readonly meta: Readonly<Record<string, RouteMetaValue>>;
  readonly schemas: RouteSchemas;
}

export interface GeneratedRouteErrorHandler {
  readonly bean: BeanClass<RouteErrorHandler>;
  readonly beanId: string;
  readonly order: number;
}

export interface GeneratedRouteTable {
  readonly schemaVersion: 1;
  readonly routes: readonly GeneratedRoute[];
  // 全局错误处理器，数组顺序即分派顺序（(order, beanId) 决胜后写死）。
  readonly errorHandlers: readonly GeneratedRouteErrorHandler[];
}
