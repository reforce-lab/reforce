// 引擎特有配置（ADR 0005 先例，同 WebNodeServeSettings）：starter 声明开放契约边，应用用
// `class ... extends ConfigProperties("...", schema) implements WebHonoServeSettings` 闭合。
// port 0 表示让操作系统分配临时端口（实际端口见启动日志）。
export interface WebHonoServeSettings {
  readonly port: number;
  readonly hostname?: string;
}
