import type { ReplacingInterceptHandle } from "@reforce/context";
import { Injectable, Interceptor } from "@reforce/context";
import { Controller, Get } from "@reforce/web";
import { Audited } from "@/method-markers";

// 方法级织入的最小取证场景（ADR 0008 AM1，#202，x-onion 同款取证法）：拦截器把标记值
// append 到被织方法的返回轨迹，HTTP 响应逐字节断言即 dist-only 链路的织入证据。

// 替换返回值的拦截器必须声明替换成什么（返回类型的类型层强制）：字段 + ReplacingInterceptHandle
// 的写法零标注，context/next 由上下文类型化。原先的 Array.isArray(result) 运行时嗅探是类型
// 缺失的补丁，收紧后不再需要。
@Interceptor({ marker: Audited })
export class AuditInterceptor {
  intercept: ReplacingInterceptHandle<{ label: string }, readonly string[]> = async (
    context,
    next,
  ) => [...(await next()), `audited:${context.value.label}`];
}

@Injectable()
export class AuditedReport {
  @Audited({ label: "report" })
  async trail(): Promise<readonly string[]> {
    return ["service"];
  }
}

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
