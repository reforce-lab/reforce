// 引擎特有配置（#238，ADR 0005 先例，同 WebNodeServeSettings）。
//
// 除 port/hostname 外的三项都是 **fastify 的构造期选项**，configurer 来不及改：`routerOptions`
// 在实例构造时读走，`initialConfig` 被冻结（实测改写抛 TypeError）。所以它们必须走 settings。
export interface WebFastifyServeSettings {
  readonly port: number;
  readonly hostname?: string;
  // 路径参数长度上限。fastify 默认 100，而 web-node 默认不限制——不显式对齐的话，同一份应用
  // 换到 fastify 上会把长参数请求静默变成 404。缺省与 web-node 一致：不限制。
  readonly maxParamLength?: number;
  // 请求体字节上限，超出即 413。缺省用 fastify 自己的默认值（1 MiB）。
  readonly bodyLimit?: number;
}
