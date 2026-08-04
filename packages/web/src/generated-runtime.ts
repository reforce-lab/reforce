// 生成的 routes.ts 的唯一 import 面（与 @reforce/context/generated-runtime 同款纪律）：
// 路由表契约类型 + handler 闭包标注所需的 RequestContext。运行时消费入口是
// createWebApplication（主入口导出），生成物本身不携带运行时逻辑。
export type { RequestContext } from "@/execution/request-context";
export type {
  GeneratedMiddlewareMount,
  GeneratedRoute,
  GeneratedRouteErrorHandler,
  GeneratedRouteMiddleware,
  GeneratedRouteTable,
} from "@/generated/route-table";
