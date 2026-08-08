import { defineApplication } from "@reforce/core";
import { logging } from "@reforce/logging";
import { web } from "@reforce/web-hono";

// 应用入口。starters 声明这个应用装上哪些能力，编译期读这个数组完成接线，运行时不做任何事。
// 换 web 引擎只改上面那行 import 的包名：三个 web starter 的导出名都叫 web。
// logging 负责启动摘要（bean 数、路由数、监听地址）和每请求一条的访问日志；不注册它，
// 应用启动就是静默的。换日志绑定同样只改包名（如 @reforce/logging-pino），导出名都叫 logging。
export default defineApplication({ starters: [logging, web] });
