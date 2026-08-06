import type { PreparedRoute } from "@reforce/web/adapter";
import type { Hono, MiddlewareHandler } from "hono";

// 两座桥（#236）。reforce 只提供机制，不定义任何自己的中间件/路由词汇——`app` 和 `MiddlewareHandler`
// 都是 hono 原生类型，用户写的就是 hono 的写法，reforce 不当中间人。
//
// 实现类是普通 @Injectable() bean，不是角色 bean（角色是编译器硬编码的四值闭集，第三方包
// 扩展不了）。因此它们正常进集合注入，写 0 个 / 1 个 / N 个都合法。
//
// 每座桥同时导出方法形态的接口与字段形态的类型（惯例见 #219）：接口是文档默认，字段形态给
// 零标注写法一条路——TS 只在"类字段 + 箭头函数"位置做上下文类型化，方法形态的 implements
// 下参数会塌成 any（tsgo 7.0.2 实测 TS7006）。configurer 比 customizer 更要紧：app 一塌成
// any，用户在 app.use() 里写的中间件回调参数会连带再报错。
//
// implements 与字段形态可以同时成立：集合成员资格靠 implements，零标注靠字段。

/**
 * 应用级 configurer：注册任何路由**之前**调用一次，用来装全局中间件与插件。
 *
 * ```ts
 * @Injectable()
 * export class Cors implements HonoConfigurer {
 *   configure: HonoConfigure = (app) => {
 *     app.use("*", cors());
 *   };
 * }
 * ```
 *
 * 时序是硬约束：`app.use` 必须排在 `app.on` 之前，之后注册对已注册的路由静默无效。
 */
export interface HonoConfigurer {
  configure(app: Hono): void | Promise<void>;
}

/** {@link HonoConfigurer.configure} 的字段形态，写成类字段即可免去参数标注。 */
export type HonoConfigure = (app: Hono) => void | Promise<void>;

/**
 * 路由级 customizer：每条路由注册**之前**调用一次，返回的中间件插在 reforce handler 之前。
 *
 * reforce 不定义任何 per-route 词汇，直接把注册点交出去——定位单条路由用 `route.meta(Marker)`
 * 或直接匹配 `route.path` / `route.method`，返回什么由用户按 hono 的写法决定。
 *
 * ```ts
 * export const RateLimit = defineRouteMarker<{ max: number }>("rateLimit");
 *
 * @Injectable()
 * export class RouteLimits implements HonoRouteCustomizer {
 *   customize: HonoRouteCustomize = (route) => {
 *     const limit = route.meta(RateLimit);
 *     return limit === undefined ? undefined : [rateLimiter({ limit: limit.max })];
 *   };
 * }
 * ```
 */
export interface HonoRouteCustomizer {
  customize(route: PreparedRoute): readonly MiddlewareHandler[] | undefined;
}

/** {@link HonoRouteCustomizer.customize} 的字段形态，写成类字段即可免去参数标注。 */
export type HonoRouteCustomize = (route: PreparedRoute) => readonly MiddlewareHandler[] | undefined;
