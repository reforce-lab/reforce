// 引擎特有配置（ADR 0005 / #207）：starter 声明开放契约边，应用用
// `class ... extends ConfigProperties("...", schema) implements WebNodeServeSettings` 闭合。
// port 0 表示让操作系统分配临时端口（实际端口见启动日志）。
export interface WebNodeServeSettings {
  readonly port: number;
  readonly hostname?: string;
}
