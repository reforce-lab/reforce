// 生成物的唯一 import 面（与 @reforce/core/generated-runtime 同款纪律）：routes.ts 消费
// 路由表契约类型 + handler 闭包标注所需的 RequestContext；bootstrap.ts 在应用注册了 web 引擎
// starter 时消费 connectWebApplication 完成接线（#153，修订记录见 #142/#152 评论区）。

// 生成的解码器/编码器常量按 StandardSchemaV1 标注(RFC 0012 S2,#274):与用户 schema 同形,
// 运行时统一按 ~standard 消费。
export type { StandardSchemaV1 } from "@standard-schema/spec";
export {
  type ConnectWebApplicationOptions,
  connectWebApplication,
  type WebStartupFacts,
} from "@/execution/connect";
export type { RequestContext } from "@/execution/request-context";
export {
  type StartupSection,
  webStartupSections,
} from "@/execution/startup-sections";
export type {
  GeneratedMiddlewareMount,
  GeneratedRoute,
  GeneratedRouteErrorHandler,
  GeneratedRouteMiddleware,
  GeneratedRouteResponse,
  GeneratedRouteSlot,
  GeneratedRouteTable,
  GeneratedSlotKind,
} from "@/generated/route-table";
