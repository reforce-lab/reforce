import { Controller, Get, type RequestContext } from "@reforce/web";
import { showHealth } from "@/features/health/health.dto";

// 健康检查：容器编排、负载均衡、监控都要探它，所以任何要部署的服务第一天就得有一个。
// 顺便说明一件事——不是每个 feature 都得凑齐 controller / service / dto 三件套，没有业务
// 规则就不必造一个 service 出来。
@Controller("/health")
export class HealthController {
  @Get("", showHealth)
  show(_context: RequestContext<typeof showHealth>) {
    return { status: "ok" as const, uptimeSeconds: Math.round(process.uptime()) };
  }
}
