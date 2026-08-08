// 日志契约与引导期设施（#347）。**零 bean**，也零框架依赖——它是全仓最底层的一层之一。
//
// 为什么它必须与 @reforce/logging 分开：@reforce/config 的绑定 phase 跑在**一切 bean 构造
// 之前**（ADR 0005 决策 6.1），那一刻容器还不存在，而它已经要写日志了。config 属 kernel 层，
// logging starter 属 observability 层——同包就意味着一条 kernel → observability 的向上依赖，
// 而那条边的下游代价是：turbo 构建环（logging 接不上 meta 生成器）、手写 meta、一份专职回读
// 自检、分组图不是 DAG。拆开之后四样一起消失。
//
// 形状与 web-core vs web-node/hono/fastify 一致：契约在下、starter bean 在上。ORM 落地时是
// 同一个模式。
//
// 用户侧不受影响：@reforce/logging 把这里的每一个导出再导出一遍，
// `import { Logger } from "@reforce/logging"` 一字不变。
export {
  type BootstrapLogBuffer,
  createBootstrapLogBuffer,
} from "@/bootstrap-buffer";
export {
  bootstrapLogger,
  drainBootstrapLogs,
  droppedBootstrapRecords,
  replayBootstrapLogs,
} from "@/bootstrap-registry";
export {
  isLevelEnabled,
  type LogFieldSource,
  type LogFields,
  type Logger,
  type LoggerFactory,
  type LogLevel,
  type LogRecord,
  type LogThreshold,
  logLevelNames,
  logLevelValues,
  logThresholdNames,
  logThresholdValues,
} from "@/contracts";
export { renderRecord, renderShortRecord } from "@/render-record";
