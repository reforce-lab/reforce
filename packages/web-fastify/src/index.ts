import { defineStarter } from "@reforce/context";

export type {
  FastifyConfigure,
  FastifyConfigurer,
  FastifyRouteCustomize,
  FastifyRouteCustomizer,
} from "@/bridges";
export { WebEngine } from "@/engine";
export type { WebFastifyServeSettings } from "@/settings";

// 注册 handle（ADR 0004，#120）：`defineApplication({ starters: [web] })` 用它指名本包。导出名
// 是这个 starter 填的能力槽，同槽的 starter 用同一个名字，应用换引擎只改 import 的包名。
export const web = defineStarter();
