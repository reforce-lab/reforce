import type { RequestScopeSeed } from "@reforce/context";
import type { HttpMethod, RouteMetaValue } from "@/routing/vocabulary";

// 适配器契约（ADR 0006 W1/W2，#142 / #152）：与路由表 schema 一起版本化的公开面。引擎适配器
// 在启动时一次性消费 WebApplication（每条 PreparedRoute 已完成校验器/序列化器/链的组装），
// 把 method+path 灌进引擎原生注册面，热路径只调用 handle——框架抽象在热路径上不存在。
// 本 milestone 只定义契约与引擎无关执行；真实引擎适配器（@reforce/web-node，node:http）是 #153 与 #207。

export interface RouteMatch {
  readonly method: HttpMethod;
  // 路由模式（如 /users/:id）与本次匹配出的原始路径参数。
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly meta: Readonly<Record<string, RouteMetaValue>>;
}

export interface PreparedRoute {
  readonly method: HttpMethod;
  readonly path: string;
  // 引擎适配器的唯一每请求入口：内部依次完成 请求作用域开启（含播种）→ 洋葱链 → 校验 →
  // handler → 序列化 → 错误处理器兜底。永不 reject——一切错误在边界内换成 Response。
  handle(request: Request, params: Readonly<Record<string, string>>): Promise<Response>;
}

export interface WebApplication {
  readonly routes: readonly PreparedRoute[];
}

export interface WebApplicationHandle {
  close(): Promise<void>;
}

export interface WebEngineAdapter {
  readonly name: string;
  start(application: WebApplication): Promise<WebApplicationHandle> | WebApplicationHandle;
}

// 每请求开启作用域 + 播种根请求 bean 的语义（ADR 0006 W7 / #151 的接线面）：播种目标必须是
// 应用图里已注册的 request bean，具体根 bean 由应用或 starter 决定，引擎无关核心不指定。
export type RequestSeeder = (request: Request, match: RouteMatch) => readonly RequestScopeSeed[];
