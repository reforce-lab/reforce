// 引擎特有配置（ADR 0005 先例，同 WebNodeServeSettings）：starter 声明开放契约边，应用用
// `class ... extends ConfigProperties("...", schema) implements WebHonoServeSettings` 闭合。
// port 0 表示让操作系统分配临时端口（实际端口见启动日志）。
export interface WebHonoServeSettings {
  readonly port: number;
  // 缺省 localhost（#323）：只有本机连得上。要对外（容器、局域网联调）就显式配 `0.0.0.0`
  // 或 `::`。三个引擎缺省一致，理由见 @reforce/web-core 的 webEngineHostname。
  readonly hostname?: string;
}
