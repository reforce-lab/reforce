import { defineStarter } from "@reforce/context";

export {
  type BeanTimingLogger,
  type BeanTimingRecord,
  beanTimingSections,
  emitBeanTimings,
} from "@/bean-timings";
export { type BootstrapLogBuffer, createBootstrapLogBuffer } from "@/bootstrap-buffer";
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
export { DefaultLoggerFactory, type DefaultLoggerFactoryOptions } from "@/default-logger";
export { DefaultLoggingFactory } from "@/generated-runtime";
export { bindLoggerLevels, type LevelBindingInput } from "@/level-binding";
export {
  environmentKeyForLogger,
  LoggerLevels,
  type LoggerLevelsSnapshot,
  parseLogThreshold,
} from "@/levels";
export { LoggerName } from "@/logger-name";
export {
  DefaultLoggingSettings,
  type LoggerLevelMap,
  type LoggingSettings,
  type LogRenderMode,
  reportUnknownLoggerLevels,
  type UnknownLoggerLevelKey,
  unknownLoggerLevelKeys,
} from "@/settings";
export {
  type EmitStartupSummaryOptions,
  emitStartupSummary,
  renderStartupSummary,
  type StartupSummary,
  type StartupSummaryLogger,
  type StartupSummaryRenderOptions,
  type StartupSummarySection,
} from "@/startup-summary";

// 注册 handle（ADR 0004，#120；升格决议见 #242 勘误）：`defineApplication({ starters: [logging] })`
// 用它指名本包。导出名是这个 starter 填的能力槽，@reforce/logging-pino 用同一个名字——
// 应用换绑定只改 import 的包名。
export const logging = defineStarter();
