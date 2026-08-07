import type { FastifyServerOptions } from "fastify";

// 引擎特有配置（#238，ADR 0005 先例，同 WebNodeServeSettings）。
//
// 除 port/hostname 外的每一项都是 **fastify 的构造期选项**，configurer 来不及改：`routerOptions`
// 在实例构造时读走，`initialConfig` 被冻结（实测改写抛 TypeError）。所以它们必须走 settings。
export interface WebFastifyServeSettings {
  readonly port: number;
  readonly hostname?: string;
  /**
   * Fastify 自带那套日志的开关，**原样**是 fastify 的类型（RFC 0011 L8，#242）。
   *
   * 我们不把 reforce 的 Logger 交给 Fastify（L8 已定：为迁就单个引擎给门面加 child，方向是
   * 反的），但「开不开是用户的事」这句话得成立——fastify 的 `logger` 是构造期选项，
   * configurer 改不了（`initialConfig` 冻结），不从 settings 递出去用户就**没有任何办法**
   * 打开它。缺省仍是 fastify 自己的缺省：关闭。开了就是 fastify 原生那套输出，与我们的
   * 请求日志各打各的，我们不假装统一。
   *
   * 类型直接引 fastify 的（不变量 5：框架不定义自己的后端配置词汇），先例是 HonoConfigurer。
   */
  readonly logger?: FastifyServerOptions["logger"];
  /** 同上，fastify 原生选项：开了 logger 之后再单独关掉它每请求两条的自动日志。 */
  readonly disableRequestLogging?: FastifyServerOptions["disableRequestLogging"];
  // 路径参数长度上限。fastify 默认 100，而 web-node 默认不限制——不显式对齐的话，同一份应用
  // 换到 fastify 上会把长参数请求静默变成 404。缺省与 web-node 一致：不限制。
  readonly maxParamLength?: number;
  // 请求体字节上限，超出即 413。缺省用 fastify 自己的默认值（1 MiB）。
  readonly bodyLimit?: number;
}
