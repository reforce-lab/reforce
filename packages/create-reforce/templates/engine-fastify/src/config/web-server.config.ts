import { ConfigProperties } from "@reforce/config";
import type { WebFastifyServeSettings } from "@reforce/web-fastify";
import { z } from "zod";

// 配置从环境变量读：前缀 webServer 加字段名，转成大写下划线，所以 port 对应 WEB_SERVER_PORT。
// 值按 .env → .env.local → .env.<REFORCE_PROFILE> → 真实环境变量 逐层叠加，后面的赢；schema
// 的 default 是兜底的第五层。环境变量恒为字符串，coerce 负责转成数字，转不动就在启动时失败，
// 报错里带上是哪个变量、来自哪一层。
//
// implements 是接线的另一半：@reforce/web-fastify 声明「我需要一份监听配置」，应用用这个类把它
// 闭合，编译期据此把配置交给引擎。删掉 implements，引擎就拿不到端口了。
//
// 嫌它啰嗦？README 的「配置的逃生舱」一节有更短的写法（代价是没有 .env 分层）。
export class WebServerConfig
  extends ConfigProperties("webServer", z.object({ port: z.coerce.number().default(3000) }))
  implements WebFastifyServeSettings {}
