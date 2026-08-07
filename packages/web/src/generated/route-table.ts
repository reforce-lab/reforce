import type { BeanClass } from "@reforce/core";
import type { StandardSchemaV1 } from "@standard-schema/spec";
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

// 槽位绑定(RFC 0012 S2,#274):每条路由按 handler 参数序声明各槽位的解码来源。
// decode 与 schema 互斥:decode 是编译器按类型生成的解码器(与用户 schema 同形,套
// ~standard 壳,运行时统一按 StandardSchemaV1 消费,输入载体按来源分派——生成解码器吃
// 原生载体 URLSearchParams/Headers,用户 schema 吃 plain object 快照);两者都缺是
// request/requestContext/responseHeaders 这类裸标注槽。key 是单键键名或第四档投影键。
export type GeneratedSlotKind =
  | "param"
  | "query"
  | "header"
  | "body"
  | "request"
  | "requestContext"
  | "responseHeaders";

export interface GeneratedRouteSlot {
  readonly slot: GeneratedSlotKind;
  readonly key?: string;
  readonly decode?: StandardSchemaV1;
  readonly schema?: StandardSchemaV1;
}

export interface GeneratedRoute<T extends object = object> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly controller: BeanClass<T>;
  readonly beanId: string;
  readonly handler: string;
  // 方法语法声明（双变参数）：生成物里每条 invoke 闭包携带具体 controller 类型，装进
  // GeneratedRoute<object> 数组仍可赋值；tsc 借闭包体背书 handler 方法存在且接收
  // RequestContext。运行时只以本 route 的 controller 实例调用它。slots 第三参是执行链
  // 解码后的槽位产物,按 handler 参数序(#274);无槽位路由传空数组。
  invoke(instance: T, context: RequestContext, slots: readonly unknown[]): unknown;
  // 压平后的完整链（ADR 0006 W4）：数组顺序即执行顺序（外→内），编译期按
  // (阶段, order, beanId) 决胜写死，运行时零决策。
  readonly middleware: readonly GeneratedRouteMiddleware[];
  readonly meta: Readonly<Record<string, RouteMetaValue>>;
  readonly schemas: RouteSchemas;
  // 槽位路由的参数绑定(#274);旧 schemas 路由缺省。过渡期两字段并存,旧链路删除时
  // schemas 退场、schemaVersion 切 2。
  readonly slots?: readonly GeneratedRouteSlot[];
  // 响应白名单投影编码器(#274):存在时 handler 返回值先经它投影再序列化;
  // 缺省走既有序列化路径。
  readonly encode?: (value: unknown) => unknown;
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
