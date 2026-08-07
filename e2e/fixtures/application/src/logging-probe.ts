import { Injectable, type OnContextStart } from "@reforce/core";
import type { LogFieldSource, Logger, LoggerLevelMap, LoggingSettings } from "@reforce/logging";
import { WebRequestFields } from "@reforce/web";

// 日志的用户链路（RFC 0011 L3 勘误，#242）。绑定不再是应用里的样板 bean：@reforce/logging
// 升格为 starter，默认绑定（零依赖 JSON writer）以 defaultBean 随 `starters: [logging, …]`
// 进图。应用要写的只剩显式级别配置——一个普通的 LoggingSettings bean，本地恒胜 starter
// 自带的全默认 DefaultLoggingSettings。

// 请求字段贡献者（RFC 0011 L4）：@reforce/web 出实现，应用决定注册不注册。它没有
// @Injectable()——web 不是 starter，本包的类不会自己进图，所以这里是一个薄子类。
// `implements LogFieldSource` 是它被链接到默认绑定那条集合边的唯一依据。
@Injectable()
export class RequestFields extends WebRequestFields implements LogFieldSource {}

// 逐 logger 调级（RFC 0011 L5 勘误）：级别词拼错是 tsc 编译错误（LogThreshold 封闭 union），
// logger 名拼错是启动期对封闭名单的确定性 warn。LoggingProbe 调开 debug、QuietProbe 不动，
// e2e 断言的正是「一条被调开、另一条不受影响」。reforce.config / reforce.core 两条框架
// logger 同样从这里调开——配置来源明细与逐 bean 台账都是 debug 档的内容（C4/C6）。
@Injectable()
export class AppLogging implements LoggingSettings {
  readonly levels = {
    LoggingProbe: "debug",
    "reforce.config": "debug",
    "reforce.core": "debug",
  } satisfies LoggerLevelMap;
}

// 两条 logger，同样在 onContextStart 各发一条 debug 与一条 info。逐 logger 调级的断言要的
// 正是「一条被调开、另一条不受影响」——只有一条 logger 时，调级生效与全局调级分不出来。
@Injectable()
export class LoggingProbe implements OnContextStart {
  constructor(private readonly log: Logger) {}

  onContextStart(): void {
    this.log.debug({ probe: "logging" }, "logging probe debug");
    this.log.info({ probe: "logging" }, "logging probe info");
  }
}

@Injectable()
export class QuietProbe implements OnContextStart {
  constructor(private readonly log: Logger) {}

  onContextStart(): void {
    this.log.debug({ probe: "quiet" }, "quiet probe debug");
    this.log.info({ probe: "quiet" }, "quiet probe info");
  }
}
