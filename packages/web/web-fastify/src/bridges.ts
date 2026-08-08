import type { PreparedRoute } from "@reforce/web-core/adapter";
import type { FastifyInstance, RouteOptions } from "fastify";

// 两座桥（#238）。reforce 只提供机制，不定义任何自己的中间件/路由词汇——`app` 与 `RouteOptions` 都是
// fastify 原生类型，用户写的就是 fastify 的写法，reforce 不当中间人。
//
// 实现类是普通 @Injectable() bean，不是角色 bean（角色是编译器硬编码的四值闭集，第三方包
// 扩展不了）。因此它们正常进集合注入，写 0 个 / 1 个 / N 个都合法。
//
// 每座桥同时导出方法形态的接口与字段形态的类型（惯例见 #219）：接口是文档默认，字段形态给
// 零标注写法一条路——TS 只在"类字段 + 箭头函数"位置做上下文类型化，方法形态的 implements
// 下参数会塌成 any。implements 与字段形态可以同时成立。

/**
 * 应用级 configurer：注册任何路由**之前**调用一次，用来装插件与全局钩子。
 *
 * ```ts
 * @Injectable()
 * export class Security implements FastifyConfigurer {
 *   configure: FastifyConfigure = async (app) => {
 *     await app.register(helmet);
 *     await app.register(compress);
 *   };
 * }
 * ```
 *
 * 构造期选项（`maxParamLength` / `bodyLimit` 等）到不了这里——它们在实例构造时就被读走，
 * `initialConfig` 是冻结的。那些请用 {@link WebFastifyServeSettings}。
 */
export interface FastifyConfigurer {
  configure(app: FastifyInstance): void | Promise<void>;
}

/** {@link FastifyConfigurer.configure} 的字段形态，写成类字段即可免去参数标注。 */
export type FastifyConfigure = (app: FastifyInstance) => void | Promise<void>;

/**
 * 路由级 customizer：每条路由注册**之前**调用一次，返回值原样合并进 `app.route()`。
 *
 * reforce 不定义任何 per-route 词汇，直接把注册点交出去——用户因此能用**任何** fastify 的
 * per-route 生态能力（`config` / `preHandler` / `constraints` / `bodyLimit`…）。
 *
 * ```ts
 * export const RateLimit = defineRouteMarker<{ max: number }>("rateLimit");
 *
 * @Injectable()
 * export class RouteLimits implements FastifyRouteCustomizer {
 *   customize: FastifyRouteCustomize = (route) => {
 *     const limit = route.meta(RateLimit);
 *     return limit && { config: { rateLimit: { max: limit.max } } };
 *   };
 * }
 * ```
 *
 * 合并规则是硬约束，见 {@link reservedRouteOptionKeys}。
 */
export interface FastifyRouteCustomizer {
  customize(route: PreparedRoute): Partial<RouteOptions> | undefined;
}

/** {@link FastifyRouteCustomizer.customize} 的字段形态，写成类字段即可免去参数标注。 */
export type FastifyRouteCustomize = (route: PreparedRoute) => Partial<RouteOptions> | undefined;

// customizer 不得覆盖的键。
//
// - method / url / handler 是 reforce 的注册面，被改写就是静默错路由。
// - schema 里只保留 response 这一条禁令：fastify 的 fast-json-stringify 会插进序列化路径，
//   与 @reforce/web-core 的 schema 白名单投影双重裁剪，结果不可预测。想要 fastify 原生 swagger
//   的用户自己手写 JSON Schema 挂到别处——reforce 因此也不暴露 PreparedRoute.schemas。
export const reservedRouteOptionKeys = ["method", "url", "handler"] as const;
