import { defineApplication } from "@reforce/context";
import type { RequestSeeder } from "@reforce/web";
import webNode from "@reforce/web-node/reforce";
import { HttpExchange, httpExchange } from "@/http-exchange";

export * from "@/config-probe";
export * from "@/greeting";
export * from "@/http-exchange";
export * from "@/lifecycle";
export * from "@/providers";
export * from "@/server-config";
export * from "@/web-config";
export * from "@/web-controllers";
export * from "@/web-errors";
export * from "@/web-markers";
export * from "@/web-middleware";
export * from "@/web-schemas";
export * from "@/worker-lifecycle";

// 根请求 bean 播种（ADR 0006 W7 / #153 接线约定）：defineApplication 模块导出的
// webRequestSeeder 由生成的 bootstrap 交给 connectWebApplication，内容按 #152 契约
// 恒为 标准 Request + 路由匹配结果。
export const webRequestSeeder: RequestSeeder = (request, match) => [
  { target: httpExchange, instance: new HttpExchange(request, match) },
];

export default defineApplication({ starters: [webNode] });
