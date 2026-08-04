// 引擎契约四类型（PreparedRoute/WebApplication/WebApplicationHandle/WebEngineAdapter）只从
// "./adapter" subpath 暴露（#187）：引擎适配器作者不依赖应用作者入口。RequestSeeder 与其签名
// 涉及的 RouteMatch 是应用作者面，保留在根入口。
export type { RequestSeeder, RouteMatch } from "@/adapter";
export {
  InvalidRouteTableError,
  ReforceWebError,
  type RequestInputSource,
  RequestValidationError,
  ResponseSerializationError,
  type WebErrorCode,
} from "@/errors";
export type { RequestContext } from "@/execution/request-context";
export {
  type CreateWebApplicationOptions,
  createWebApplication,
} from "@/execution/web-application";
export {
  Controller,
  Delete,
  ErrorHandler,
  Get,
  Head,
  Middleware,
  Options,
  Patch,
  Post,
  Put,
  Use,
} from "@/routing/decorators";
export type {
  ErrorHandlerOptions,
  MiddlewareOptions,
  RouteErrorHandler,
  RouteMiddleware,
} from "@/routing/middleware";
export { defineRouteMarker, type RouteMarker } from "@/routing/route-marker";
export type { HttpMethod, RouteMetaValue, RouteSchemas, WebPhase } from "@/routing/vocabulary";
