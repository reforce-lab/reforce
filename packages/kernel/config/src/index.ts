// 用户入口：只暴露声明 API。metadata symbol 与 reader 属包内私有，
// 由 generated-runtime 侧消费，不从这里导出（ADR 0005）
export { ConfigProperties, type ConfigPropertiesClass } from "@/config-properties";
export { type ConfigErrorCode, configErrorCodes } from "@/error-codes";
