import { defineApplication } from "@reforce/core";
import { logging } from "@reforce/logging";
import type { RequestSeeder } from "@reforce/web-core";
import { web } from "@reforce/web-node";
import { HttpExchange, httpExchange } from "@/http-exchange";

// 入口不 re-export 任何应用模块（#314）：编译器按 leaf tsconfig include 扫描全部源文件，
// provider 无需从入口可达。本 fixture 走 e2e 全链路，是该行为的活体证明——不要往回加
// `export *`。
// 根请求 bean 播种（ADR 0006 W7 / #153 接线约定）：defineApplication 模块导出的
// webRequestSeeder 由生成的 bootstrap 交给 connectWebApplication，内容按 #152 契约
// 恒为 标准 Request + 路由匹配结果。
export const webRequestSeeder: RequestSeeder = (request, match) => [
  { target: httpExchange, instance: new HttpExchange(request, match) },
];

export default defineApplication({ starters: [logging, web] });
