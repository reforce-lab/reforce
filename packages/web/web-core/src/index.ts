// 引擎契约四类型（PreparedRoute/WebApplication/WebApplicationHandle/WebEngineAdapter）只从
// "./adapter" subpath 暴露（#187）：引擎适配器作者不依赖应用作者入口。RequestSeeder 是应用
// 作者面，保留在根入口。
export type { RequestSeeder } from "@/adapter";
export { type WebErrorCode, webErrorCodes } from "@/error-codes";
export * as errors from "@/error-namespace";
export {
  InvalidRouteTableError,
  MiddlewareReenteredError,
  ReforceWebError,
  type RequestInputSource,
  RequestValidationError,
  ResponseSerializationError,
} from "@/errors";
export {
  fromStandardRequest,
  type IncomingRequest,
} from "@/execution/incoming-request";
export type { RequestContext } from "@/execution/request-context";
export {
  currentRequestId,
  type WebRequestFacts,
  WebRequestFields,
} from "@/execution/request-fields";
// 内部响应货币（#340）。用户面要它的场合：中间件的 `next()` 返回值类型；需要完全掌控
// 状态码/头/体时用 `respond()` 显式造一条（取代「为了这个只好 new Response」，那条路会真的
// 造出一个标准对象连带一条流）；拿到它之后用 `readRouteBody()` 读体；自建 harness 或测试
// 替身直接扮演 `PreparedRoute.handle` 时用 `absorbResponse()` 复用框架逃生口的同一套语义。
export {
  absorbResponse,
  type ResponseBody,
  type RouteOutcome,
  type RouteResponse,
  readRouteBody,
  respond,
} from "@/execution/route-response";
export {
  type CreateWebApplicationOptions,
  createWebApplication,
} from "@/execution/web-application";
export {
  BadRequestError,
  ConflictError,
  type DefineHttpErrorOptions,
  defineHttpError,
  ForbiddenError,
  HttpError,
  type HttpErrorInput,
  type HttpErrorOptions,
  NotFoundError,
  UnauthorizedError,
} from "@/http-errors";
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
  type ResponseDomain,
  ResponseSchema,
  ResponseStatus,
  Throws,
  Use,
} from "@/routing/decorators";
export type {
  ErrorHandlerHandle,
  ErrorHandlerOptions,
  MiddlewareHandle,
  MiddlewareOptions,
  RouteErrorHandler,
  RouteMiddleware,
} from "@/routing/middleware";
export { defineRouteMarker, type RouteMarker } from "@/routing/route-marker";
export type { Body, Header, Param, Query } from "@/routing/slots";
export type { HttpMethod, RouteMetaValue, WebPhase } from "@/routing/vocabulary";
