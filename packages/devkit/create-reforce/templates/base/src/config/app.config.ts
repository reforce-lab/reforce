import { ConfigProperties } from "@reforce/config";
import { z } from "zod";

// 应用自己的配置。前缀 app 加字段名，转成大写下划线就是环境变量名：apiKey → APP_API_KEY。
// 值按 .env → .env.local → .env.<REFORCE_PROFILE> → 真实环境变量 逐层叠加，后面的赢；
// schema 的 default 是兜底的第五层。
//
// apiKey 是 optional 的：模板希望你 clone 下来直接能跑，所以不配就等于关掉鉴权（见
// infrastructure/web/api-key.middleware.ts）。真上线时把 optional 去掉，让它在启动
// 期就因为缺配置而失败——总比线上裸奔强。
export class AppConfig extends ConfigProperties(
  "app",
  z.object({
    apiKey: z.string().min(8).optional(),
  }),
) {}
