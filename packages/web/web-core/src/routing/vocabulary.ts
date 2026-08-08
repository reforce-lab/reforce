// web 面的封闭词汇（ADR 0006 W1/W4，#142 / #152）：方法与阶段都是闭集，编译器按同一份
// 字面量联合做诊断，路由表校验按同一份闭集拒绝未知值。扩展任何一侧都要同步另一侧。

export type HttpMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";

const httpMethods = new Set<string>(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);

export function isHttpMethod(value: unknown): value is HttpMethod {
  return typeof value === "string" && httpMethods.has(value);
}

// 中间件阶段闭集（ADR 0006 W4 待打磨项定案，#152）：取 Micronaut ServerFilterPhase 的
// 命名阶段思路，扔掉 FIRST/LAST 一类位置占位。数组顺序即链上顺序（外→内）：
// - observability：最外层，观测所有请求与最终响应，不做业务准入决策；
// - admission：准入判定（认证/授权/限流），短路的典型位置；
// - application：默认阶段，贴近 handler 的业务拦截。
// 阶段内按 order 升序，同序值按 beanId 决胜，编译期把每条路由的链压平写死进路由表。
export const webPhases = ["observability", "admission", "application"] as const;

export type WebPhase = (typeof webPhases)[number];

export function isWebPhase(value: unknown): value is WebPhase {
  return typeof value === "string" && (webPhases as readonly string[]).includes(value);
}

export function webPhaseRank(phase: WebPhase): number {
  return webPhases.indexOf(phase);
}

// 路由元数据值 = JSON 字面量树（ADR 0006 W3 待打磨项定案，#152）：编译器只提取静态
// 字面量形态，路由表因此可稳定序列化、可 diff。
export type RouteMetaValue =
  | string
  | number
  | boolean
  | null
  | readonly RouteMetaValue[]
  | { readonly [key: string]: RouteMetaValue };
