// 引擎特有配置（ADR 0005 / #207）：starter 声明开放契约边，应用用
// `class ... extends ConfigProperties("...", schema) implements WebNodeServeSettings` 闭合。
// port 0 表示让操作系统分配临时端口（实际端口见启动日志）。
export interface WebNodeServeSettings {
  readonly port: number;
  readonly hostname?: string;
  // 路径参数长度上限（find-my-way 的 maxParamLength，#211）：缺省不限制，与手写路由时代一致。
  // 设成有限值即启用上游的超长参数保护，超限的请求按未命中处理（404）。
  readonly maxParamLength?: number;
}
