import { defineRouteMarker } from "@reforce/web";

// 类型化路由元数据（ADR 0006 W3）：编译器把 @Roles([...]) 的字面量参数提取进路由表，
// 中间件经 context.meta(Roles) 按声明类型读回。
export const Roles = defineRouteMarker<readonly string[]>("roles");
