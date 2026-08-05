import type { MethodInterceptor, MethodInvocationContext } from "@reforce/context";
import { Injectable, Interceptor } from "@reforce/context";
import { Controller, Get } from "@reforce/web";
import { Audited } from "@/method-markers";

// 方法级织入的最小取证场景（ADR 0008 AM1，#202，x-onion 同款取证法）：拦截器把标记值
// append 到被织方法的返回轨迹，HTTP 响应逐字节断言即 dist-only 链路的织入证据。

@Injectable()
@Interceptor({ marker: Audited })
export class AuditInterceptor implements MethodInterceptor<{ label: string }> {
  async intercept(
    context: MethodInvocationContext<{ label: string }>,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    const result = await next();
    return Array.isArray(result) ? [...result, `audited:${context.value.label}`] : result;
  }
}

@Injectable()
export class AuditedReport {
  @Audited({ label: "report" })
  async trail(): Promise<readonly string[]> {
    return ["service"];
  }
}

@Injectable()
@Controller("/woven")
export class WovenController {
  constructor(private readonly report: AuditedReport) {}

  // 本路由不带 response schema，因此按 W5 契约直接返回 Response。
  @Get()
  async show(): Promise<Response> {
    return new Response(JSON.stringify({ trail: await this.report.trail() }), {
      headers: { "content-type": "application/json" },
    });
  }
}
