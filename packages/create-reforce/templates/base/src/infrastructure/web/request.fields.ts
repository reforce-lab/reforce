import { Injectable } from "@reforce/core";
import type { LogFieldSource } from "@reforce/logging";
import { WebRequestFields } from "@reforce/web";

// 请求字段贡献者：注册它之后，请求期间发出的每条应用日志都自动带上 method 和 path，
// 不用每个调用点手写。实现是 @reforce/web 出的，但用不用由应用决定，框架不自动注册——
// 这个薄子类打上 @Injectable() 就是「要用」的声明；`implements LogFieldSource` 是它被
// 日志绑定识别的唯一依据，删了它字段就断供。
@Injectable()
export class RequestFields extends WebRequestFields implements LogFieldSource {}
