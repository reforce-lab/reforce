import { defineApplication } from "@reforce/core";
import { web } from "@reforce/web-node";

// 应用入口。starters 声明这个应用装上哪些能力，编译期读这个数组完成接线，运行时不做任何事。
// 换 web 引擎只改上面那行 import 的包名：三个 web starter 的导出名都叫 web。
export default defineApplication({ starters: [web] });
