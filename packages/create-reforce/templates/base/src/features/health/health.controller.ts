import { Controller, Get } from "@reforce/web";

// 健康检查：容器编排、负载均衡、监控都要探它，所以任何要部署的服务第一天就得有一个。
// 顺便说明两件事——不是每个 feature 都得凑齐 controller / service / dto 三件套，没有业务
// 规则就不必造 service；没有请求输入、响应又简单时，连 dto 文件都不必有，返回类型标注
// 一个就地声明的 interface 就是完整的线上契约。
interface HealthReport {
  readonly status: "ok";
  readonly uptimeSeconds: number;
}

@Controller("/health")
export class HealthController {
  @Get()
  show(): HealthReport {
    return { status: "ok", uptimeSeconds: Math.round(process.uptime()) };
  }
}
