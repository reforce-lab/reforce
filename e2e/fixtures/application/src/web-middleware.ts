import { Middleware, type RequestContext, type RouteResponse, respond } from "@reforce/web-core";
import { Roles } from "@/web-markers";

// 洋葱中间件（ADR 0006 W4）：三个阶段各一枚，全部全局挂载。每层在 await next() 之后把
// 自己的标签 append 到 x-onion 响应头——内层的后相先执行，因此头的值就是"内→外"的执行
// 顺序证据，e2e 逐字节断言，且按响应隔离天然并发安全。

async function tag(next: () => Promise<RouteResponse>, label: string): Promise<RouteResponse> {
  const response = await next();
  response.headers.append("x-onion", label);
  return response;
}

@Middleware({ phase: "observability", global: true })
export class ObservabilityTrace {
  handle(_context: RequestContext, next: () => Promise<RouteResponse>): Promise<RouteResponse> {
    return tag(next, "observability");
  }
}

// 准入短路（guard 语义）：路由声明了 @Roles 且请求没带 x-user 就直接 403，不调 next()——
// 校验在全部中间件之后执行，因此被短路的请求不会进 reforce 的 body 解析。引擎侧读没读完
// socket 各家不同（web-node 没读，fastify 一定读完才进 handler）。
@Middleware({ phase: "admission", global: true })
export class RoleGuard {
  handle(
    context: RequestContext,
    next: () => Promise<RouteResponse>,
  ): RouteResponse | Promise<RouteResponse> {
    const roles = context.meta(Roles);
    if (roles !== undefined && context.request.headers.get("x-user") === null) {
      // 短路用 respond() 而不是 new Response(...)（#340）：后者仍是合法的逃生口，但它会真的
      // 造一个标准对象连带一条 ReadableStream，引擎再拆回字节。respond 交出的就是引擎要的形态。
      context.responseHeaders.set("content-type", "application/json");
      return respond(context.responseHeaders, 403, JSON.stringify({ error: "forbidden", roles }));
    }
    return tag(next, "admission");
  }
}

@Middleware({ phase: "application", global: true })
export class ApplicationTrace {
  handle(_context: RequestContext, next: () => Promise<RouteResponse>): Promise<RouteResponse> {
    return tag(next, "application");
  }
}
