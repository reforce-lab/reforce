import { defineStarter } from "@reforce/context";

export type {
  PinoConfigure,
  PinoConfigurer,
  PinoDestination,
  PinoDestinationProvider,
} from "@/bridges";
export { PinoLoggerFactory } from "@/factory";
export type { PinoSettings } from "@/settings";

// 注册 handle（ADR 0004，#120；形状随 #244 改为主入口具名导出）：
// `defineApplication({ starters: [logging] })` 用它指名本包。导出名是这个 starter 填的能力
// 槽，同槽的 starter 用同一个名字，应用换绑定只改 import 的包名。
export const logging = defineStarter();
