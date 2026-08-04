import { defineBean, Injectable, RequestScoped } from "@reforce/context";
import type { RouteMatch } from "@reforce/web";

// 根请求 bean（ADR 0006 W7）：值 = 标准 Request + 路由匹配结果，由 webRequestSeeder（见
// application.ts）每请求播种，其余请求 bean 从它派生。create 只在未播种的请求作用域里
// 兜底执行——web 链路恒播种，走到这里就是接线缺陷，抛错比造假值诚实。
export class HttpExchange {
  constructor(
    readonly request: Request,
    readonly match: RouteMatch,
  ) {}
}

export const httpExchange = defineBean<HttpExchange>({
  scope: "request",
  create: (): HttpExchange => {
    throw new Error("HttpExchange is seeded per request by the web engine.");
  },
});

// 派生请求 bean：从根请求 bean 读每请求身份，供并发隔离断言用（x-request-id 不串值）。
@Injectable()
@RequestScoped()
export class RequestAudit {
  constructor(private readonly exchange: HttpExchange) {}

  get requestId(): string {
    return this.exchange.request.headers.get("x-request-id") ?? "anonymous";
  }

  get matchedPath(): string {
    return this.exchange.match.path;
  }
}
