import { Injectable } from "@reforce/context";
import { Middleware, type RequestContext } from "@reforce/web";
import { Roles } from "@/web-markers";

// 洋葱中间件（ADR 0006 W4）：三个阶段各一枚，全部全局挂载。每层在 await next() 之后把
// 自己的标签 append 到 x-onion 响应头——内层的后相先执行，因此头的值就是"内→外"的执行
// 顺序证据，e2e 逐字节断言，且按响应隔离天然并发安全。

async function tag(
  context: RequestContext,
  next: () => Promise<Response>,
  label: string,
): Promise<Response> {
  const response = await next();
  response.headers.append("x-onion", label);
  return response;
}

@Injectable()
@Middleware({ phase: "observability", global: true })
export class ObservabilityTrace {
  handle(context: RequestContext, next: () => Promise<Response>): Promise<Response> {
    return tag(context, next, "observability");
  }
}

// 准入短路（guard 语义）：路由声明了 @Roles 且请求没带 x-user 就直接 403，不调 next()——
// 校验在全部中间件之后执行，因此被短路的请求连 body 都不会读。
@Injectable()
@Middleware({ phase: "admission", global: true })
export class RoleGuard {
  handle(context: RequestContext, next: () => Promise<Response>): Response | Promise<Response> {
    const roles = context.meta(Roles);
    if (roles !== undefined && context.request.headers.get("x-user") === null) {
      return new Response(JSON.stringify({ error: "forbidden", roles }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    return tag(context, next, "admission");
  }
}

@Injectable()
@Middleware({ phase: "application", global: true })
export class ApplicationTrace {
  handle(context: RequestContext, next: () => Promise<Response>): Promise<Response> {
    return tag(context, next, "application");
  }
}
