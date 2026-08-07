// 生成物的唯一 import 面（与 @reforce/core/generated-runtime 同款纪律）：routes.ts 消费
// 路由表契约类型 + handler 闭包标注所需的 RequestContext；bootstrap.ts 在应用注册了 web 引擎
// starter 时消费 connectWebApplication 完成接线（#153，修订记录见 #142/#152 评论区）。
export {
  type ConnectWebApplicationOptions,
  connectWebApplication,
} from "@/execution/connect";
export type { RequestContext } from "@/execution/request-context";
export type {
  GeneratedMiddlewareMount,
  GeneratedRoute,
  GeneratedRouteErrorHandler,
  GeneratedRouteMiddleware,
  GeneratedRouteTable,
} from "@/generated/route-table";
