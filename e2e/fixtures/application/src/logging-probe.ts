import { Injectable, type OnContextStart } from "@reforce/context";
import {
  DefaultLoggerFactory,
  type LogFieldSource,
  type Logger,
  type LoggerFactory,
  type LoggerLevels,
} from "@reforce/logging";
import { WebRequestFields } from "@reforce/web";

// 日志的用户链路（RFC 0011 L3/L5，#249）。这里装的是**默认绑定**——零依赖内置 writer，
// 用户自己注册。@reforce/logging 不是 starter（RFC L3 已定），所以绑定必须是应用里的一条
// 普通 @Injectable() bean，正如这个类所示。
//
// 关键的一行是 `new DefaultLoggerFactory({ levels })`：LoggerLevels 是编译器合成的级别快照
// bean，接上它 `logging.level.*` 与 `LOGGING_LEVEL_<NAME>` 才真正生效。少了它，编译期照样
// 校验拼写、照样给 did-you-mean，但用户改级别不会有任何效果。

// 请求字段贡献者（RFC 0011 L4）：@reforce/web 出实现，应用决定注册不注册。它没有
// @Injectable()——web 不是 starter，本包的类不会自己进图，所以这里是一个薄子类。
// `implements LogFieldSource` 是它被链接到那条集合边的唯一依据。
@Injectable()
export class RequestFields extends WebRequestFields implements LogFieldSource {}

@Injectable()
export class FixtureLoggerFactory implements LoggerFactory {
  private readonly delegate: DefaultLoggerFactory;

  // fieldSources 是集合注入（ADR 0006 W6）：0 个 / 1 个 / N 个都合法。装了贡献者的应用，
  // 每条日志都自带它们的字段；没装的应用连一次遍历都不会发生（L4 的空集合分支）。
  constructor(levels: LoggerLevels, fieldSources: readonly LogFieldSource[]) {
    this.delegate = new DefaultLoggerFactory({ levels, fieldSources });
  }

  create(name: string): Logger {
    return this.delegate.create(name);
  }
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
